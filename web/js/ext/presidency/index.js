// Presidency: play the President through yearly budget seasons on the real map (Civ USA game mode).
//
//   app mode "presidency"; URL hash: #president=1; top-bar button "Presidency"
//   data: web/data/presidency.json (budget, levers, cabinet, events), plus states.json and counties.json
//   model.js holds the simulation (pure, unit-tested); this file is the screens and the map wiring.
//
// The baseline is real data. Everything after inauguration is a teaching model: every effect is badged
// "Game rule" until a published estimate replaces it (see presidency.json "basis").
import * as M from "./model.js";

const SAVE_KEY = "civusa-presidency-v1";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fin = (v) => typeof v === "number" && Number.isFinite(v);

// Diverging: worse (brick) ← no change (parchment) → better (teal).
const CHANGE_RAMP = ["#7a1f2b", "#c2463d", "#e8a07a", "#efe6d2", "#8fcbb8", "#2e9c8a", "#0f5e57"];

function injectCss() {
  if (document.getElementById("presidency-css")) return;
  const l = document.createElement("link");
  l.id = "presidency-css";
  l.rel = "stylesheet";
  l.href = new URL("../../../css/presidency.css", import.meta.url).href;
  document.head.appendChild(l);
}

// --- formatting ----------------------------------------------------------------------------------------------------

const money = (b) => (Math.abs(b) >= 1000 ? `$${(b / 1000).toFixed(2)} trillion` : `$${Math.round(b)} billion`);
function fmt(ind, v) {
  if (!fin(v)) return "n/a";
  switch (ind.format) {
    case "pct": return `${(v * 100).toFixed(1)}%`;
    case "usd": return `$${Math.round(v).toLocaleString("en-US")}`;
    case "usd_big": return `$${(v / 1e12).toFixed(2)} trillion`;
    default: return v.toFixed(1);
  }
}
function fmtChange(ind, a, b) {
  if (!fin(a) || !fin(b)) return "";
  const better = ind.higher_is === "bad" ? b < a : b > a;
  const same = Math.abs(b - a) < 1e-9 * Math.max(1, Math.abs(a));
  let t;
  if (ind.kind === "relative") t = `${b >= a ? "+" : ""}${((b / a - 1) * 100).toFixed(2)}%`;
  else if (ind.format === "pct") t = `${b >= a ? "+" : ""}${((b - a) * 100).toFixed(2)} pts`;
  else t = `${b >= a ? "+" : ""}${(b - a).toFixed(1)}`;
  return `<span class="pr-chg ${same ? "" : better ? "good" : "bad"}">${t}</span>`;
}
const badge = (basis) => basis === "real"
  ? `<span class="pr-badge real" title="Real data from a public source, cited in the Almanac">Real data</span>`
  : `<span class="pr-badge game" title="A designer's assumption, not a published estimate. See 'How this game models effects'.">Game rule</span>`;

// --- the extension ---------------------------------------------------------------------------------------------------

export function install(app) {
  injectCss();
  let content = null, game = null, dock = null, screen = "title", lensInd = null;

  const save = () => {
    if (!game) return;
    try { const { content: _c, ...rest } = game; localStorage.setItem(SAVE_KEY, JSON.stringify(rest)); } catch { /* storage blocked */ }
  };
  const loadSaved = () => {
    try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); return s && s.version === 1 ? s : null; } catch { return null; }
  };
  const clearSaved = () => { try { localStorage.removeItem(SAVE_KEY); } catch { /* storage blocked */ } };

  const ready = () => Promise.all([app.loadData("presidency"), app.loadCounties()]).then(([p]) => (content = p));

  const btn = app.ui.addTopButton({
    id: "btn-presidency", icon: "🏛️", label: "Presidency", title: "Presidency: run the country, one budget at a time",
    onClick: () => (app.mode === "presidency" ? app.setMode(null) : app.setMode("presidency")),
  });
  app.on("mode", ({ name }) => btn?.setAttribute("aria-pressed", String(name === "presidency")));

  app.registerMode("presidency", {
    enter() {
      dock = app.ui.dock("right", { width: Math.min(460, Math.max(340, innerWidth * 0.36)), label: "Presidency" });
      dock.classList.add("pr-dock");
      dock.innerHTML = `<div class="pr-root"><p class="muted">Loading the Oval Office…</p></div>`;
      ready().then(() => {
        if (!content) { dock.innerHTML = `<div class="pr-root"><p>presidency.json is missing.</p></div>`; return; }
        if (!game) { const s = loadSaved(); if (s) { game = { ...s, content }; screen = "game"; } }
        render();
      }, (err) => { dock.innerHTML = `<div class="pr-root"><p>Could not load the game data (${esc(err.message)}).</p></div>`; });
    },
    exit() {
      save();
      app.setHighlight(null);
      if (lensInd) { app.setLens(null); lensInd = null; }
      dock?.classList.remove("pr-dock");
      app.ui.undock("right");
      dock = null;
    },
  });
  app.hash.register("president", {
    get: () => (app.mode === "presidency" ? "1" : null),
    set: (v) => { if (v && app.mode !== "presidency") app.setMode("presidency"); },
  });

  // --- map wiring -----------------------------------------------------------------------------------------------------

  const stateIdx = (abbr) => app.w.raw.states.findIndex((s) => s.abbr === abbr);
  function focusState(abbr) {
    const idx = stateIdx(abbr);
    if (idx < 0) return;
    const h = { states: new Set([idx]) };
    app.setHighlight(h);
    const b = app.highlightBounds(h);
    if (b) app.fitBounds(b.x0, b.y0, b.x1, b.y1, { maxScale: 2.2 });
  }
  function showChangeLens(indId) {
    const ind = game.content.indicators.find((i) => i.id === indId);
    const imp = M.improvement(game, indId);
    const owner = app.w.raw.owner, abbrs = app.w.raw.states.map((s) => s.abbr);
    const values = new Array(app.w.grid.size).fill(null);
    for (let i = 0; i < values.length; i++) if (owner[i] >= 0) { const v = imp[abbrs[owner[i]]]; if (fin(v)) values[i] = v; }
    const mx = Math.max(1e-6, ...Object.values(imp).filter(fin).map(Math.abs));
    const pct = ind.format === "pct" || ind.kind === "relative";
    app.setLens({
      id: `pres-${indId}-${game.year}-${game.history.length}`, group: "people", name: `Your term: ${ind.name}`,
      icon: "layers", emoji: "🏛️", unit: pct ? (ind.kind === "relative" ? "% better since inauguration" : "points better since inauguration") : "points better since inauguration",
      format: pct ? "pct" : "float", scale: "linear", domain: [-mx, mx], ramp: CHANGE_RAMP, higher_is: "good", source: "",
      description: `Change in ${ind.name.toLowerCase()} since you took office, by state, signed so that teal is better. Starts from real data (${ind.source}); every change after that comes from the game's model, whose effect sizes are game rules, not forecasts.`,
      values,
    });
    lensInd = indId;
  }

  // --- screens --------------------------------------------------------------------------------------------------------

  function render() {
    if (!dock) return;
    const root = document.createElement("div");
    root.className = "pr-root";
    root.innerHTML = screen === "title" || !game ? titleScreen() : `${header()}${body()}`;
    dock.innerHTML = "";
    dock.appendChild(root);
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
    root.scrollTop = 0;
    save();
  }

  function titleScreen() {
    const saved = loadSaved();
    const b = content.budget;
    return `
      <h2 class="pr-title">You are the President</h2>
      <p>Four years, maybe eight. Each year you direct new federal money across the country, your cabinet fights for your ear, and crises land on real places. Then the map shows what changed.</p>
      <div class="pr-note"><b>What is real, what is a game.</b> The starting point is real: every state's income, jobs, coverage, broadband and degrees come from federal data in the Almanac. The budget figures are real: the government spent ${money(b.lines[0].value)} in fiscal year ${b.fiscal_year}, and borrowed ${money(b.lines[2].value)}. What happens after you take office is a teaching model, not a forecast. Every effect is labelled ${badge("game")} until it is backed by a published study.</div>
      <div class="pr-actions">
        ${saved ? `<button class="btn pr-primary" data-act="resume">Resume year ${saved.year}</button>` : ""}
        <button class="btn ${saved ? "" : "pr-primary"}" data-act="new">Take the oath</button>
      </div>
      ${budgetContext()}`;
  }

  function budgetContext() {
    const b = content.budget, d = b.discretionary;
    return `<details class="pr-ctx"><summary>The real budget, fiscal year ${b.fiscal_year}</summary>
      <table class="pr-table"><tbody>${b.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="num">${money(l.value)}</td></tr>`).join("")}
      <tr><td>Discretionary spending (defense ${money(d.defense)}, nondefense ${money(d.nondefense)})</td><td class="num">${money(d.value)}</td></tr></tbody></table>
      <p class="pr-small">Sources: <a href="${esc(b.source.url)}" target="_blank" rel="noopener">${esc(b.source.title)}</a>; <a href="${esc(d.source.url)}" target="_blank" rel="noopener">${esc(d.source.title)}</a>. ${esc(d.note)}</p>
      <p class="pr-small">${esc(b.initiatives_fund.note)} ${badge("game")}</p></details>`;
  }

  function header() {
    const g = game;
    const term = g.year <= 4 ? "First term" : "Second term";
    const seats = g.content.seats.map((s) => {
      const v = g.influence[s.id];
      return `<div class="pr-seat" title="${esc(s.title)}: ${esc(s.view)}"><span class="pr-seat-dot" style="background:${s.color}"></span><span class="pr-seat-name">${esc(s.title.replace(/^Secretary of (the )?/, ""))}</span><span class="pr-seat-bar"><i style="width:${v.toFixed(0)}%;background:${s.color}"></i></span><span class="pr-seat-v">${v.toFixed(0)}</span></div>`;
    }).join("");
    return `<header class="pr-head">
      <div class="pr-stats"><span><b>Year ${g.year}</b> · ${term}</span><span>Approval <b>${g.approval.toFixed(0)}%</b> ${badge("game")}</span><span>Fund <b>${money(g.fund)}</b></span></div>
      ${g.phase !== "inaugurate" ? `<div class="pr-cabinet"><div class="pr-small muted">Cabinet influence (shares of 100)</div>${seats}</div>` : ""}
    </header>`;
  }

  function body() {
    switch (game.phase) {
      case "inaugurate": return inaugurateScreen();
      case "briefing": return briefingScreen();
      case "budget": return budgetScreen();
      case "event": return eventScreen();
      case "report": return reportScreen();
      case "over": return overScreen();
      default: return "";
    }
  }

  function inaugurateScreen() {
    const chosen = new Set(game.mandate);
    return `<h3>Inauguration Day</h3>
      <p>Choose the three priorities you will be judged on. Your mandate, not the game, decides what success means.</p>
      <div class="pr-chips">${game.content.mandates.map((m) => `<button class="pr-chip ${chosen.has(m.id) ? "on" : ""}" data-act="mandate" data-id="${m.id}" aria-pressed="${chosen.has(m.id)}">${esc(m.name)}</button>`).join("")}</div>
      <p class="pr-small muted">${chosen.size}/3 chosen.</p>
      <div class="pr-actions"><button class="btn pr-primary" data-act="oath" ${chosen.size === 3 ? "" : "disabled"}>Begin the first year</button></div>`;
  }

  const seatOf = (id) => game.content.seats.find((s) => s.id === id);
  const leverOf = (id) => game.content.levers.find((l) => l.id === id);
  const indOf = (id) => game.content.indicators.find((i) => i.id === id);
  const who = (id) => `<span class="pr-who" style="--c:${seatOf(id).color}">${esc(game.secretaries[id])}, ${esc(seatOf(id).title)}</span>`;

  function describeExpect(indId, v) {
    const ind = indOf(indId);
    if (ind.kind === "relative") return `${(v * 100).toFixed(2)}% higher ${ind.name.toLowerCase()}`;
    if (ind.format === "pct") return `${Math.abs(v * 100).toFixed(2)} points ${v * (ind.higher_is === "bad" ? -1 : 1) > 0 ? "better" : "worse"} on ${ind.name.toLowerCase()}`;
    return `${v.toFixed(1)} points on the ${ind.name.toLowerCase()}`;
  }

  function briefingScreen() {
    const i = game.popups.findIndex((p) => !p.done);
    if (i < 0) {
      return `<h3>Cabinet briefing</h3><p>Your cabinet has said its piece. ${Object.keys(game.pledges).length ? `You have promised money to ${Object.keys(game.pledges).map((k) => esc(leverOf(k).name)).join(" and ")}.` : ""}</p>
        <div class="pr-actions"><button class="btn pr-primary" data-act="to-budget">Open budget season</button></div>`;
    }
    const p = game.popups[i];
    let card = "";
    if (p.kind === "pitch") {
      const lv = leverOf(p.lever);
      card = `<div class="pr-card" style="--c:${seatOf(p.seat).color}"><div class="pr-kind">Pitch</div>${who(p.seat)}
        <p>"${esc(seatOf(p.seat).view)} Give me ${money(p.amount)} for ${esc(lv.name.toLowerCase())} and you will see about ${esc(describeExpect(p.ind, p.expect))} nationally within ${p.lagYears} year${p.lagYears > 1 ? "s" : ""}."</p>
        <p class="pr-small muted">Every secretary oversells their own programs a little. If you agree, their prediction is scored when the effect lands. ${badge("game")}</p>
        <div class="pr-actions"><button class="btn pr-primary" data-act="popup" data-i="${i}" data-c="accept">Promise ${money(p.amount)}</button><button class="btn" data-act="popup" data-i="${i}" data-c="decline">Not this year</button></div></div>`;
    } else if (p.kind === "clash") {
      const [a, b] = p.seats, [la, lb] = p.levers;
      card = `<div class="pr-card clash"><div class="pr-kind">Cabinet clash</div>
        <p>${who(a)} and ${who(b)} both want the next ${money(p.amount)}.</p>
        <div class="pr-split"><div style="--c:${seatOf(a).color}"><b>${esc(leverOf(la).name)}</b><p class="pr-small">"${esc(seatOf(a).view)}"</p></div><div style="--c:${seatOf(b).color}"><b>${esc(leverOf(lb).name)}</b><p class="pr-small">"${esc(seatOf(b).view)}"</p></div></div>
        <p class="pr-small muted">The winner gains influence and the loser loses it. Deferring irritates both.</p>
        <div class="pr-actions"><button class="btn" data-act="popup" data-i="${i}" data-c="${a}">Side with ${esc(leverOf(la).name)}</button><button class="btn" data-act="popup" data-i="${i}" data-c="${b}">Side with ${esc(leverOf(lb).name)}</button><button class="btn" data-act="popup" data-i="${i}" data-c="defer">Defer</button></div></div>`;
    } else if (p.kind === "resign") {
      card = `<div class="pr-card" style="--c:${seatOf(p.seat).color}"><div class="pr-kind">Resignation threat</div>${who(p.seat)}
        <p>"I have been shut out for two years. Either this White House listens to my department, or I go, and I will say why."</p>
        <div class="pr-actions"><button class="btn" data-act="popup" data-i="${i}" data-c="accept">Accept the resignation</button><button class="btn pr-primary" data-act="popup" data-i="${i}" data-c="decline">Ask them to stay</button></div>
        <p class="pr-small muted">Accepting costs approval. Asking them to stay gives them influence at the expense of your strongest secretary.</p></div>`;
    }
    return `<h3>Cabinet briefing</h3><p class="pr-small muted">${i + 1} of ${game.popups.length}</p>${card}`;
  }

  function budgetScreen() {
    const g = game;
    const total = Object.values(g.alloc).reduce((a, b) => a + b, 0);
    const left = g.fund - total;
    const rows = g.content.levers.map((lv) => {
      const v = g.alloc[lv.id] || 0, min = g.pledges[lv.id] || 0;
      const prev = lv.effects.slice(0, 2).map((e) => v ? `${esc(describeExpect(e.ind, M.preview(g, lv.id, v, e.ind)))} over ${e.lag.length} yr` : "").filter(Boolean).join("; ");
      return `<div class="pr-lever"><div class="pr-lever-top"><span class="pr-seat-dot" style="background:${seatOf(lv.seat).color}" title="${esc(seatOf(lv.seat).title)}"></span><b>${esc(lv.name)}</b><span class="num">${money(v)}</span></div>
        <input type="range" min="0" max="${g.fund}" step="5" value="${v}" data-lever="${lv.id}" aria-label="${esc(lv.name)} in billions of dollars">
        <div class="pr-small muted">${esc(lv.blurb)}${min ? ` Promised: at least ${money(min)}.` : ""}</div>
        ${prev ? `<div class="pr-small">Expected: ${prev} ${badge("game")}</div>` : lv.id === "deficit" && v ? `<div class="pr-small">Borrow ${money(v)} less this year.</div>` : ""}</div>`;
    }).join("");
    const opts = (sel) => `<option value="">None</option>${g.order.map((s) => `<option value="${s}" ${sel === s ? "selected" : ""}>${esc(g.names[s])}</option>`).join("")}`;
    return `<h3>Budget season, year ${g.year}</h3>
      <p>Direct this year's fund of ${money(g.fund)}. Any money you spend is borrowed on top of the ${money(g.content.budget.lines[2].value)} baseline deficit, unless you put it toward deficit reduction.</p>
      <div class="pr-left ${left < 0 ? "bad" : ""}">Unallocated: <b>${money(left)}</b></div>
      ${rows}
      <h4>Priority states</h4>
      <p class="pr-small">Up to three. They get ${Math.round(M.PRIORITY_SHARE * 100)}% of every program's money; the rest is spread by population. ${badge("game")}</p>
      <div class="pr-pri">${[0, 1, 2].map((k) => `<select data-pri="${k}" aria-label="Priority state ${k + 1}">${opts(g.priority[k])}</select>`).join("")}</div>
      <div class="pr-actions"><button class="btn pr-primary" data-act="submit">Sign the budget</button></div>
      ${budgetContext()}`;
  }

  function eventScreen() {
    const g = game, e = g.events[g.eventIndex], def = M.eventDef(g, e);
    const f = g.facts[e.st] || {};
    const pc = (v) => (fin(v) ? `${(v * 100).toFixed(1)}%` : "n/a");
    const text = def.text.replace("{state}", esc(g.names[e.st])).replace("{disasters}", fin(f.disasters) ? f.disasters.toFixed(0) : "several")
      .replace("{rent_burden}", pc(f.rent_burden)).replace("{manufacturing}", pc(f.manufacturing)).replace("{uninsured}", pc(f.uninsured)).replace("{growth}", pc(f.growth));
    const place = g.content.event_places?.[def.pick];
    return `<h3>Crisis: ${esc(def.title)}</h3><p class="pr-small muted">${g.eventIndex + 1} of ${g.events.length} this year</p>
      <div class="pr-card crisis"><p>${text}</p>
      ${place ? `<p class="pr-small muted">${esc(place.note)}</p>` : `<p class="pr-small muted">Place picked by a rule from the data ${badge("real")}</p>`}
      ${def.options.map((o, k) => `<button class="pr-option" data-act="event" data-k="${k}"><b>${esc(o.label)}</b><span class="pr-small">${o.cost ? `${money(o.cost)}, borrowed` : "No federal cost"} · backed by ${esc(seatOf(o.backer).title.replace(/^Secretary of (the )?/, ""))}</span><span class="pr-small muted">${esc(o.note)}</span></button>`).join("")}
      <p class="pr-small muted">Effects of each option are game rules ${badge("game")}</p></div>`;
  }

  function reportScreen() {
    const g = game, r = g.report;
    const rows = g.content.indicators.map((ind) => `<tr><td>${esc(ind.name)}${ind.id === "grid" || ind.id === "resilience" ? ` ${badge("game")}` : ""}</td><td class="num">${fmt(ind, r.after[ind.id])}</td><td class="num">${fmtChange(ind, r.before[ind.id], r.after[ind.id])}</td><td><button class="pr-map ${lensInd === ind.id ? "on" : ""}" data-act="lens" data-id="${ind.id}" title="Map the change since inauguration">Map</button></td></tr>`).join("");
    const scored = r.scored.filter((s) => s.verdict !== "unfunded").map((s) => `<li>${who(s.seat)} predicted ${esc(describeExpect(s.ind, s.expect))}. The model delivered ${esc(describeExpect(s.ind, s.actual))}: <b>${s.verdict === "accurate" ? "close enough, influence up" : "oversold, influence down"}</b>.</li>`).join("");
    const log = g.log.filter((l) => l.year === r.year).map((l) => `<li>${esc(l.text)}</li>`).join("");
    let politics = "";
    if (r.midterm) politics = `<div class="pr-note"><b>Midterms.</b> With approval at ${r.approval.toFixed(0)}%, Congress sets next year's fund at ${Math.round(r.midterm.congress * 100)}% of normal: ${money(Math.round(g.content.budget.initiatives_fund.value * r.midterm.congress))}. ${badge("game")}</div>`;
    if (r.election) politics = `<div class="pr-note ${r.election.won ? "good" : "bad"}"><b>Election night.</b> ${r.election.won ? "You won a second term." : "You lost re-election."} Approval ${r.approval.toFixed(0)}%, plus ${r.election.swing >= 0 ? "a" : "a negative"} ${Math.abs(r.election.swing).toFixed(1)}-point swing on the day. ${badge("game")}</div>`;
    const last = (r.election && !r.election.won) || g.year >= M.MAX_YEARS;
    return `<h3>Year ${r.year} report</h3>
      <p>Approval ${r.dApproval >= 0 ? "rose" : "fell"} ${Math.abs(r.dApproval).toFixed(1)} points to <b>${r.approval.toFixed(0)}%</b>. You borrowed ${money(r.borrowed)} beyond the baseline, including ${money(r.interest)} in interest on your earlier borrowing.</p>
      ${politics}
      <table class="pr-table"><thead><tr><th>National</th><th class="num">Now</th><th class="num">This year</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="pr-small muted">Starting values are ${badge("real")}; each year's change comes from the game's model ${badge("game")}. Grid reliability and disaster resilience are game indices with no real data behind them. National income is a population-weighted mean of state medians, not the true national median.</p>
      ${scored ? `<h4>Track record</h4><ul class="pr-list">${scored}</ul>` : ""}
      ${log ? `<h4>This year</h4><ul class="pr-list">${log}</ul>` : ""}
      <div class="pr-actions"><button class="btn pr-primary" data-act="next">${last ? (g.year >= M.MAX_YEARS ? "Leave office (two terms is the limit)" : "Leave office") : `Begin year ${g.year + 1}`}</button></div>`;
  }

  function overScreen() {
    const g = game, r = g.result;
    const rows = g.content.indicators.map((ind) => `<tr><td>${esc(ind.name)}</td><td class="num">${fmt(ind, g.startNational[ind.id])}</td><td class="num">${fmt(ind, r.end[ind.id])}</td><td><button class="pr-map ${lensInd === ind.id ? "on" : ""}" data-act="lens" data-id="${ind.id}">Map</button></td></tr>`).join("");
    return `<h3>${r.how === "defeated" ? "Your presidency ends after one term" : "Two terms served. The Constitution says that is enough."}</h3>
      <p>Legacy score on your mandate (${g.mandate.map((m) => esc(g.content.mandates.find((x) => x.id === m).name)).join(", ")}): <b>${r.legacy.toFixed(0)}</b> of 100 ${badge("game")}. You added ${money(r.debt)} to the national debt.</p>
      <table class="pr-table"><thead><tr><th></th><th class="num">Inauguration</th><th class="num">Leaving office</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="pr-actions"><button class="btn pr-primary" data-act="restart">Run again</button></div>`;
  }

  // --- input ----------------------------------------------------------------------------------------------------------

  function onClick(ev) {
    const b = ev.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "new" || act === "restart") {
      clearSaved();
      game = M.newGame({ content, states: app.data.states, counties: app.data.counties });
      screen = "game";
      app.setHighlight(null);
      if (lensInd) { app.setLens(null); lensInd = null; }
    } else if (act === "resume") {
      game = { ...loadSaved(), content };
      screen = "game";
    } else if (act === "mandate") {
      const id = b.dataset.id, m = game.mandate;
      const k = m.indexOf(id);
      if (k >= 0) m.splice(k, 1); else if (m.length < 3) m.push(id);
    } else if (act === "oath") {
      M.chooseMandate(game, game.mandate);
    } else if (act === "popup") {
      M.answerPopup(game, Number(b.dataset.i), b.dataset.c);
    } else if (act === "to-budget") {
      M.startBudget(game);
    } else if (act === "submit") {
      M.submitBudget(game);
      if (game.phase === "event") focusState(game.events[0].st);
    } else if (act === "event") {
      M.answerEvent(game, Number(b.dataset.k));
      if (game.phase === "event") focusState(game.events[game.eventIndex].st);
      else { app.setHighlight(null); app.home(); showChangeLens(game.mandate.map((m) => game.content.mandates.find((x) => x.id === m).inds[0]).find((i) => i !== "_deficit") || "income"); }
    } else if (act === "lens") {
      showChangeLens(b.dataset.id);
    } else if (act === "next") {
      M.nextYear(game);
      if (game.phase === "over") app.home();
    }
    if (act === "submit" && game.phase === "report") { app.home(); showChangeLens("income"); }
    render();
  }

  function onInput(ev) {
    const t = ev.target;
    if (t.dataset.lever) {
      const id = t.dataset.lever;
      const min = game.pledges[id] || 0;
      const others = Object.entries(game.alloc).reduce((a, [k, v]) => a + (k === id ? 0 : v), 0);
      game.alloc[id] = Math.max(min, Math.min(Number(t.value), game.fund - others));
      t.value = game.alloc[id];
      // While dragging, update the numbers in place (a re-render would drop the slider); redraw on release.
      const num = t.closest(".pr-lever")?.querySelector(".num");
      if (num) num.textContent = money(game.alloc[id]);
      const left = dock?.querySelector(".pr-left b");
      if (left) left.textContent = money(game.fund - Object.values(game.alloc).reduce((a, b) => a + b, 0));
      if (ev.type === "change") render();
    } else if (t.dataset.pri != null && ev.type === "change") {
      const k = Number(t.dataset.pri);
      const pri = [game.priority[0] || "", game.priority[1] || "", game.priority[2] || ""];
      pri[k] = t.value;
      game.priority = [...new Set(pri.filter(Boolean))];
      if (t.value) focusState(t.value);
      render();
    }
  }
}
