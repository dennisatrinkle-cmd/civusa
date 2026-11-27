// The Presidency simulation: pure functions over a plain game object, with no DOM, so it can be unit-tested
// (node --test web/js/ext/presidency/model.test.js) and saved to localStorage as JSON.
//
// The baseline is real data (states.json, counties.json). Everything after year 1 is a teaching model, not a
// forecast: every effect size comes from presidency.json and carries a basis ("game" for all of them in this
// version). Rules marked GAME RULE below are designer assumptions, chosen to make trade-offs visible.

export const MAX_YEARS = 8; // two terms; the 22nd Amendment bars a third
export const PRIORITY_SHARE = 0.4; // GAME RULE: share of every lever's money that goes to the priority states
export const REF_PERCAP = 300; // GAME RULE: dollars per resident at which a lever's effect reaches ln(2) of its "per"
export const NOISE = 0.25; // GAME RULE: outcomes land within ±25% of the nominal effect
export const START_APPROVAL = 50; // GAME RULE
export const HIGH_INFLUENCE = 25; // GAME RULE: a secretary this strong runs their levers 10% more efficiently
export const LOW_INFLUENCE = 8; // GAME RULE: two years below this and a secretary threatens to resign

// --- random numbers (seeded, so a saved game and a shared seed replay the same way) --------------------------

export function rng(game) {
  // mulberry32 on game.rngState
  let t = (game.rngState = (game.rngState + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (game, arr) => arr[Math.floor(rng(game) * arr.length)];

// --- baseline from the real data ---------------------------------------------------------------------------------

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** Population-weighted state means of county columns (counties.json is {columns, rows}). */
export function rollCounties(counties, keys) {
  const out = {};
  if (!counties?.columns) return out;
  const col = Object.fromEntries(counties.columns.map((c, i) => [c, i]));
  for (const r of counties.rows) {
    const st = r[col.state], pop = r[col.population];
    if (!st || !fin(pop)) continue;
    const o = (out[st] ??= { _w: {} });
    for (const k of keys) {
      const v = r[col[k]];
      if (!fin(v)) continue;
      o[k] = (o[k] || 0) + v * pop;
      o._w[k] = (o._w[k] || 0) + pop;
    }
  }
  for (const st of Object.keys(out)) {
    for (const k of keys) out[st][k] = out[st]._w[k] ? out[st][k] / out[st]._w[k] : null;
    delete out[st]._w;
  }
  return out;
}

/** Per-state starting indicators. Returns {abbr: {ind: value}} plus populations and facts used by event text. */
export function buildBaseline(states, counties) {
  const rolled = rollCounties(counties, ["uninsured", "broadband", "bachelors", "amenities", "disasters"]);
  const base = {}, pop = {}, facts = {}, names = {}, order = [];
  states.forEach((s) => {
    if (!fin(s.population) || s.population <= 0) return;
    const c = rolled[s.abbr] || {};
    order.push(s.abbr);
    names[s.abbr] = s.name;
    pop[s.abbr] = s.population;
    base[s.abbr] = {
      income: s.median_income ?? null,
      unemployment: s.unemployment ?? null,
      rent_burden: s.rent_burden ?? null,
      uninsured: c.uninsured ?? null,
      broadband: c.broadband ?? null,
      bachelors: c.bachelors ?? null,
      gdp: s.gdp ?? null,
      wellbeing: c.amenities ?? null,
      grid: 60, // GAME INDEX, not real data
      resilience: 50, // GAME INDEX, not real data
    };
    facts[s.abbr] = {
      disasters: c.disasters ?? null,
      manufacturing: s.jobs && s.employed ? (s.jobs.manufacturing || 0) / s.employed : null,
      growth: s.growth ?? null,
      rent_burden: s.rent_burden ?? null,
      uninsured: c.uninsured ?? null,
    };
  });
  return { base, pop, facts, names, order };
}

// --- national roll-up ----------------------------------------------------------------------------------------------

/** Population-weighted national means; GDP is summed. Median income is a population-weighted mean of state medians,
 *  an approximation of the national median (it is not the same statistic). */
export function national(game, cur = game.cur) {
  const out = {};
  for (const ind of game.content.indicators) {
    let s = 0, w = 0;
    for (const st of game.order) {
      const v = cur[st][ind.id];
      if (!fin(v)) continue;
      if (ind.id === "gdp") { s += v; w = 1; } else { s += v * game.pop[st]; w += game.pop[st]; }
    }
    out[ind.id] = w ? s / w : null;
  }
  return out;
}

// --- new game ------------------------------------------------------------------------------------------------------

export function newGame({ content, states, counties, seed = Date.now() >>> 0 }) {
  const b = buildBaseline(states, counties);
  const game = {
    version: 1, seed, rngState: seed >>> 0,
    content, // presidency.json (kept in the object so the model is self-contained)
    order: b.order, names: b.names, pop: b.pop, facts: b.facts,
    base: b.base, cur: JSON.parse(JSON.stringify(b.base)),
    year: 1, phase: "inaugurate", mandate: [],
    fund: content.budget.initiatives_fund.value, congress: 1,
    approval: START_APPROVAL, debt: 0, lastBorrowed: 0,
    influence: {}, lowYears: {}, bias: {}, secretaries: {},
    pending: [], chains: [], usedEvents: [],
    alloc: {}, priority: [], pledges: {}, popups: [], events: [], eventIndex: 0, eventCost: 0,
    predictions: [], history: [], log: [], result: null,
  };
  const seats = content.seats;
  for (const s of seats) {
    game.influence[s.id] = 100 / seats.length;
    game.lowYears[s.id] = 0;
    game.bias[s.id] = 1 + rng(game) * 0.5; // GAME RULE: every secretary oversells their own programs by 0–50%
    game.secretaries[s.id] = s.name;
  }
  game.startNational = national(game);
  return game;
}

export function chooseMandate(game, ids) {
  game.mandate = ids.slice(0, 3);
  game.phase = "briefing";
  game.popups = makeBriefing(game);
}

// --- influence (a fixed pie of 100) -------------------------------------------------------------------------------

export function shiftInfluence(game, deltas) {
  const inf = game.influence;
  for (const [k, d] of Object.entries(deltas)) if (k in inf) inf[k] = Math.max(1, inf[k] + d);
  const total = Object.values(inf).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(inf)) inf[k] = (inf[k] / total) * 100;
}

const seat = (game, id) => game.content.seats.find((s) => s.id === id);
const lever = (game, id) => game.content.levers.find((l) => l.id === id);
const indicator = (game, id) => game.content.indicators.find((i) => i.id === id);

// --- effects --------------------------------------------------------------------------------------------------------

/** How much a lever's spending moves one indicator in one state, before lags and noise. */
export function effectSize(game, eff, dollarsB, st) {
  const percap = (dollarsB * 1e9) / game.pop[st];
  return eff.per * Math.log(1 + percap / REF_PERCAP);
}

/** Split a lever's money across states: PRIORITY_SHARE to the priority states, the rest by population. */
export function splitByState(game, dollarsB, priority = game.priority) {
  const out = {};
  const totalPop = game.order.reduce((a, s) => a + game.pop[s], 0);
  const pri = priority.filter((s) => game.pop[s]);
  const priPop = pri.reduce((a, s) => a + game.pop[s], 0);
  const broad = pri.length ? 1 - PRIORITY_SHARE : 1;
  for (const st of game.order) out[st] = dollarsB * broad * (game.pop[st] / totalPop);
  for (const st of pri) out[st] += dollarsB * PRIORITY_SHARE * (game.pop[st] / priPop);
  return out;
}

function applyDelta(game, st, indId, d) {
  const ind = indicator(game, indId);
  const v = game.cur[st][indId];
  if (!ind || !fin(v)) return;
  let nv = ind.kind === "relative" ? v * (1 + d) : v + d;
  if (ind.format === "pct") nv = Math.min(1, Math.max(0, nv));
  if (indId === "grid" || indId === "resilience") nv = Math.min(100, Math.max(0, nv)); // game indices run 0–100
  else if (ind.format === "index") nv = Math.max(0, nv); // the wellbeing index is centred on 100 and can exceed it
  game.cur[st][indId] = nv;
}

/** Nominal first-year national change in an indicator if `dollarsB` goes to a lever (for previews and pitches). */
export function preview(game, leverId, dollarsB, indId) {
  const lv = lever(game, leverId);
  const eff = lv?.effects.find((e) => e.ind === indId);
  if (!eff) return 0;
  const split = splitByState(game, dollarsB, []);
  let s = 0, w = 0;
  for (const st of game.order) {
    const d = effectSize(game, eff, split[st], st) * eff.lag.reduce((a, b) => a + b, 0);
    if (indicator(game, indId).kind === "relative") { s += d * game.pop[st]; w += game.pop[st]; }
    else { s += d * game.pop[st]; w += game.pop[st]; }
  }
  return w ? s / w : 0;
}

// --- briefing: cabinet pop-ups -------------------------------------------------------------------------------------

function makeBriefing(game) {
  const out = [];
  const seats = game.content.seats;
  // Resignation threats first.
  for (const s of seats) if (game.lowYears[s.id] >= 2) out.push({ kind: "resign", seat: s.id });
  // Two pitches: the strongest secretary speaks first, then a random other one.
  const bySway = [...seats].sort((a, b) => game.influence[b.id] - game.influence[a.id]);
  const pitchers = [bySway[0], pick(game, bySway.slice(1))];
  for (const s of pitchers) {
    const levers = game.content.levers.filter((l) => l.seat === s.id && l.effects.length);
    if (!levers.length) continue;
    const lv = pick(game, levers);
    const eff = lv.effects[0];
    const amount = 50; // GAME RULE: pitches ask for $50 billion
    const nominal = preview(game, lv.id, amount, eff.ind);
    out.push({ kind: "pitch", seat: s.id, lever: lv.id, amount, ind: eff.ind, expect: nominal * game.bias[s.id], lagYears: eff.lag.length });
  }
  // One clash between rivals.
  const a = pick(game, seats);
  const b = seat(game, a.rival);
  if (b) {
    const la = game.content.levers.find((l) => l.seat === a.id && l.id !== "deficit") || game.content.levers.find((l) => l.seat === a.id);
    const lb = game.content.levers.find((l) => l.seat === b.id && l.id !== "rebate") || game.content.levers.find((l) => l.seat === b.id);
    if (la && lb) out.push({ kind: "clash", seats: [a.id, b.id], levers: [la.id, lb.id], amount: 40 });
  }
  return out;
}

/** Resolve one briefing pop-up. choice: "accept" | "decline" for pitches and resignations, a seat id for clashes. */
export function answerPopup(game, idx, choice) {
  const p = game.popups[idx];
  if (!p || p.done) return;
  p.done = true;
  p.choice = choice;
  if (p.kind === "pitch") {
    if (choice === "accept") {
      game.pledges[p.lever] = Math.max(game.pledges[p.lever] || 0, p.amount);
      game.predictions.push({ seat: p.seat, lever: p.lever, amount: p.amount, ind: p.ind, expect: p.expect, year: game.year, lagYears: p.lagYears });
      shiftInfluence(game, { [p.seat]: 3 });
    } else shiftInfluence(game, { [p.seat]: -3 });
  } else if (p.kind === "clash") {
    const k = p.seats.indexOf(choice);
    if (k < 0) {
      shiftInfluence(game, { [p.seats[0]]: -2, [p.seats[1]]: -2 }); // deferring irritates both
    } else {
      game.pledges[p.levers[k]] = Math.max(game.pledges[p.levers[k]] || 0, p.amount);
      shiftInfluence(game, { [p.seats[k]]: 6, [p.seats[1 - k]]: -6 });
    }
  } else if (p.kind === "resign") {
    if (choice === "accept") {
      game.approval -= 3;
      game.secretaries[p.seat] = `${seat(game, p.seat).name.split(" ")[0]}'s successor`;
      game.influence[p.seat] = 12;
      shiftInfluence(game, {});
      game.log.push({ year: game.year, text: `${seat(game, p.seat).title} resigned.` });
    } else {
      const top = Object.keys(game.influence).sort((x, y) => game.influence[y] - game.influence[x])[0];
      shiftInfluence(game, { [p.seat]: 6, [top]: -6 });
    }
    game.lowYears[p.seat] = 0;
  }
}

export function startBudget(game) {
  game.phase = "budget";
  for (const l of game.content.levers) game.alloc[l.id] = Math.max(game.alloc[l.id] || 0, game.pledges[l.id] || 0);
  normalizeAlloc(game);
}

/** Keep the allocation within the fund: scale unpledged levers down if over. */
export function normalizeAlloc(game) {
  const total = Object.values(game.alloc).reduce((a, b) => a + b, 0);
  if (total <= game.fund) return;
  const pledged = Object.fromEntries(Object.entries(game.alloc).map(([k, v]) => [k, Math.min(v, game.pledges[k] || 0)]));
  const pTotal = Object.values(pledged).reduce((a, b) => a + b, 0);
  const free = Math.max(0, game.fund - pTotal);
  const rest = total - pTotal;
  for (const k of Object.keys(game.alloc)) game.alloc[k] = pledged[k] + (rest ? ((game.alloc[k] - pledged[k]) * free) / rest : 0);
}

// --- budget -------------------------------------------------------------------------------------------------------

export function submitBudget(game) {
  normalizeAlloc(game);
  const y = game.year;
  for (const lv of game.content.levers) {
    const dollars = game.alloc[lv.id] || 0;
    if (!dollars || !lv.effects.length) continue;
    const boost = game.influence[lv.seat] >= HIGH_INFLUENCE ? 1.1 : 1;
    const split = splitByState(game, dollars);
    for (const eff of lv.effects) {
      const noise = 1 + (rng(game) * 2 - 1) * NOISE;
      for (const st of game.order) {
        const d = effectSize(game, eff, split[st], st) * noise * boost;
        eff.lag.forEach((share, k) => { if (share) game.pending.push({ year: y + k, st, ind: eff.ind, d: d * share, lever: lv.id }); });
      }
    }
  }
  // Influence follows the money (a fixed pie of 100).
  const total = Object.values(game.alloc).reduce((a, b) => a + b, 0) || 1;
  const bySeat = {};
  for (const lv of game.content.levers) bySeat[lv.seat] = (bySeat[lv.seat] || 0) + (game.alloc[lv.id] || 0) / total;
  const fair = 1 / game.content.seats.length;
  shiftInfluence(game, Object.fromEntries(game.content.seats.map((s) => [s.id, 15 * ((bySeat[s.id] || 0) - fair)])));
  // A neglected secretary may leak to the press.
  for (const s of game.content.seats) {
    if (game.influence[s.id] < 10 && rng(game) < 0.35) {
      game.approval -= 2;
      game.log.push({ year: y, text: `${game.secretaries[s.id]} (${s.title}) told reporters the White House is ignoring them.`, leak: s.id });
    }
  }
  game.events = drawEvents(game);
  game.eventIndex = 0;
  game.eventCost = 0;
  game.phase = game.events.length ? "event" : "report";
  if (game.phase === "report") endYear(game);
}

// --- events -----------------------------------------------------------------------------------------------------------

function topStates(game, key, n = 8) {
  return game.order.filter((s) => fin(game.facts[s][key])).sort((a, b) => game.facts[b][key] - game.facts[a][key]).slice(0, n);
}

function placeFor(game, ev) {
  if (ev.pick === "fab" || ev.pick === "drought") return pick(game, game.content.event_places[ev.pick].states.filter((s) => game.pop[s]));
  return pick(game, topStates(game, ev.pick));
}

function drawEvents(game) {
  const out = [];
  const due = game.chains.filter((c) => c.year === game.year);
  game.chains = game.chains.filter((c) => c.year !== game.year);
  for (const c of due) out.push({ id: c.id, st: c.st });
  const n = game.year === 1 ? 1 : 1 + (rng(game) < 0.5 ? 1 : 0); // GAME RULE: one or two crises a year
  const pool = game.content.events.filter((e) => !e.chainOnly);
  for (let k = 0; out.length < n + due.length && k < 20; k++) {
    let cands = pool.filter((e) => !game.usedEvents.includes(e.id) && !out.some((o) => o.id === e.id));
    if (!cands.length) { game.usedEvents = []; cands = pool.filter((e) => !out.some((o) => o.id === e.id)); }
    const ev = pick(game, cands);
    game.usedEvents.push(ev.id);
    out.push({ id: ev.id, st: placeFor(game, ev) });
  }
  return out;
}

export function eventDef(game, e) { return game.content.events.find((x) => x.id === e.id); }

export function answerEvent(game, optIdx) {
  const e = game.events[game.eventIndex];
  const def = eventDef(game, e);
  const opt = def.options[optIdx];
  e.choice = optIdx;
  game.eventCost += opt.cost;
  game.approval += opt.effects.approval || 0;
  for (const [ind, d] of Object.entries(opt.effects.state || {})) applyDelta(game, e.st, ind, d);
  const others = def.seats.filter((s) => s !== opt.backer);
  shiftInfluence(game, { [opt.backer]: 5, ...Object.fromEntries(others.map((s) => [s, -3])) });
  if (opt.chain && rng(game) < 0.5) game.chains.push({ id: opt.chain, st: e.st, year: game.year + 1 + Math.floor(rng(game) * 2) }); // GAME RULE: odds of a repeat
  game.log.push({ year: game.year, text: `${def.title} in ${game.names[e.st]}: ${opt.label.toLowerCase()}.` });
  game.eventIndex++;
  if (game.eventIndex >= game.events.length) { game.phase = "report"; endYear(game); }
}

// --- year end -----------------------------------------------------------------------------------------------------------

// GAME RULE: how big a change counts as one "point" of progress, per indicator, for approval and the legacy score.
const SCALE = { income: 0.005, gdp: 0.005, unemployment: 0.001, rent_burden: 0.004, uninsured: 0.005, broadband: 0.005, bachelors: 0.002, wellbeing: 1, grid: 3, resilience: 3 };

export function progress(game, indId, from, to) {
  const ind = indicator(game, indId);
  if (!ind || !fin(from) || !fin(to)) return 0;
  const raw = ind.kind === "relative" ? to / from - 1 : to - from;
  return (ind.higher_is === "bad" ? -raw : raw) / (SCALE[indId] || 1);
}

function mandateScore(game, from, to, borrowed) {
  let s = 0, n = 0;
  for (const m of game.mandate) {
    const def = game.content.mandates.find((x) => x.id === m);
    for (const ind of def?.inds || []) {
      s += ind === "_deficit" ? -borrowed / 60 : progress(game, ind, from[ind], to[ind]);
      n++;
    }
  }
  return n ? s / n : 0;
}

function endYear(game) {
  const y = game.year;
  const before = national(game);
  for (const p of game.pending.filter((p) => p.year === y)) applyDelta(game, p.st, p.ind, p.d);
  game.pending = game.pending.filter((p) => p.year > y);
  const after = national(game);

  // Money: what was borrowed beyond the baseline deficit (held flat, a GAME RULE simplification).
  const spent = Object.entries(game.alloc).reduce((a, [k, v]) => a + (k === "deficit" ? 0 : v), 0);
  const cut = game.alloc.deficit || 0;
  const interest = game.debt * game.content.budget.interest_rate.value;
  const borrowed = spent + game.eventCost + interest - cut;
  game.debt += borrowed;
  game.lastBorrowed = borrowed;

  // Approval (GAME RULE): progress on the mandate, a little for progress overall, a cost for borrowing, and drift.
  const mScore = mandateScore(game, before, after, borrowed);
  const all = game.content.indicators.reduce((a, i) => a + progress(game, i.id, before[i.id], after[i.id]), 0) / game.content.indicators.length;
  const dApproval = Math.max(-5, Math.min(5, 2 * mScore)) + 0.3 * all - borrowed / 300 - 0.3;
  game.approval = Math.max(15, Math.min(85, game.approval + dApproval));

  // Track record: predictions whose effect has fully landed are scored.
  const scored = [];
  for (const pr of game.predictions.filter((p) => p.year + p.lagYears - 1 === y)) {
    const funded = (game.history.find((h) => h.year === pr.year)?.alloc?.[pr.lever] ?? game.alloc[pr.lever] ?? 0) >= pr.amount * 0.9;
    if (!funded) { scored.push({ ...pr, verdict: "unfunded" }); continue; }
    const actual = preview(game, pr.lever, pr.amount, pr.ind); // nominal; noise is shared by the whole program
    const ratio = pr.expect ? actual / pr.expect : 0;
    const verdict = ratio > 0.8 ? "accurate" : "oversold";
    shiftInfluence(game, { [pr.seat]: verdict === "accurate" ? 4 : -2 });
    scored.push({ ...pr, actual, verdict });
  }
  game.predictions = game.predictions.filter((p) => p.year + p.lagYears - 1 > y);

  for (const s of game.content.seats) game.lowYears[s.id] = game.influence[s.id] < LOW_INFLUENCE ? game.lowYears[s.id] + 1 : 0;

  const rec = {
    year: y, alloc: { ...game.alloc }, priority: [...game.priority], events: game.events.map((e) => ({ ...e })),
    before, after, approval: game.approval, dApproval, borrowed, interest, influence: { ...game.influence }, scored,
  };
  if (y === 2 || y === 6) {
    // Midterms (GAME RULE): approval sets how much Congress gives you for the next two years.
    game.congress = Math.max(0.6, Math.min(1.2, 0.7 + (game.approval - 35) / 50));
    rec.midterm = { congress: game.congress };
  }
  if (y === 4) {
    const swing = (rng(game) * 2 - 1) * 3; // GAME RULE: ±3 points of luck on election day
    rec.election = { approval: game.approval, swing, won: game.approval + swing >= 50 };
  }
  game.history.push(rec);
  game.report = rec;
}

/** After the year-end report: on to the next year, or the end of the presidency. */
export function nextYear(game) {
  const rec = game.report;
  if ((rec.election && !rec.election.won) || game.year >= MAX_YEARS) return finish(game, rec.election && !rec.election.won ? "defeated" : "term-limited");
  game.year++;
  game.fund = Math.round(game.content.budget.initiatives_fund.value * game.congress);
  game.alloc = {};
  game.pledges = {};
  game.priority = [];
  game.events = [];
  game.phase = "briefing";
  game.popups = makeBriefing(game);
}

function finish(game, how) {
  const end = national(game);
  const legacy = Math.max(0, Math.min(100, 50 + 4 * mandateScore(game, game.startNational, end, game.debt / Math.max(1, game.year))));
  game.result = { how, years: game.year, legacy, end, debt: game.debt };
  game.phase = "over";
}

/** Change since inauguration, signed so that positive is better, per state, in display units. */
export function improvement(game, indId) {
  const ind = indicator(game, indId);
  const out = {};
  for (const st of game.order) {
    const a = game.base[st][indId], b = game.cur[st][indId];
    if (!fin(a) || !fin(b)) { out[st] = null; continue; }
    const raw = ind.kind === "relative" ? b / a - 1 : b - a;
    out[st] = ind.higher_is === "bad" ? -raw : raw;
  }
  return out;
}
