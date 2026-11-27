// Run: node --test web/js/ext/presidency/model.test.js   (Node 18+; reads the real web/data files)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as M from "./model.js";

const load = (n) => JSON.parse(readFileSync(new URL(`../../../data/${n}.json`, import.meta.url)));
const content = load("presidency"), states = load("states"), counties = load("counties");
const fresh = (seed = 7) => M.newGame({ content, states, counties, seed });

function playYear(game, alloc) {
  for (let i = 0; i < game.popups.length; i++) {
    const p = game.popups[i];
    M.answerPopup(game, i, p.kind === "clash" ? p.seats[0] : "accept");
  }
  M.startBudget(game);
  Object.assign(game.alloc, alloc);
  M.submitBudget(game);
  while (game.phase === "event") M.answerEvent(game, 0);
  assert.equal(game.phase, "report");
}

test("baseline comes from the real data", () => {
  const g = fresh();
  assert.ok(g.order.length >= 48);
  assert.equal(g.base.IN.income, states.find((s) => s.abbr === "IN").median_income);
  assert.ok(g.base.IN.uninsured > 0 && g.base.IN.uninsured < 0.3);
  const nat = M.national(g);
  assert.ok(Math.abs(nat.gdp - states.reduce((a, s) => a + (s.gdp || 0), 0)) < 1);
});

test("influence is a fixed pie of 100", () => {
  const g = fresh();
  M.shiftInfluence(g, { treasury: 30, health: -10 });
  const sum = Object.values(g.influence).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9);
});

test("priority states get more money per resident", () => {
  const g = fresh();
  const split = M.splitByState(g, 100, ["WV"]);
  assert.ok(split.WV / g.pop.WV > 5 * (split.CA / g.pop.CA));
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 100) < 1e-9);
});

test("spending on health lowers the uninsured rate, with lags", () => {
  const g = fresh();
  M.chooseMandate(g, ["health", "jobs", "fiscal"]);
  playYear(g, { health: 200 });
  const r = g.history[0];
  assert.ok(r.after.uninsured < r.before.uninsured);
});

test("a full game ends by the eighth year at the latest and same seed replays the same way", () => {
  const run = () => {
    const g = fresh(42);
    M.chooseMandate(g, ["jobs", "skills", "growth"]);
    while (g.phase !== "over") {
      playYear(g, { apprenticeships: 80, education: 60, broadband: 60, infrastructure: 50 });
      M.nextYear(g);
    }
    return g;
  };
  const a = run(), b = run();
  assert.ok(a.result.years === 4 || a.result.years === 8);
  assert.ok(a.year <= M.MAX_YEARS);
  assert.equal(a.result.legacy, b.result.legacy);
  assert.equal(JSON.stringify(a.cur), JSON.stringify(b.cur));
  assert.ok(Number.isFinite(a.result.legacy));
});

test("a saved game survives JSON", () => {
  const g = fresh();
  M.chooseMandate(g, ["affordability", "health", "fiscal"]);
  const h = JSON.parse(JSON.stringify(g));
  playYear(h, { housing: 150, deficit: 100 });
  assert.equal(h.history.length, 1);
});
