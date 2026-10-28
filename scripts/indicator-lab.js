#!/usr/bin/env node
// Do the user's MTA-HedgeB / M-EMA-Bot indicators help the DLMM strategy?
// Per labeled coin, simulate today's label strategy and variants that add an
// indicator entry gate, an indicator exit, a different range width or a
// position-based shape skew. Pick on validate, report test (fit/validate unused
// for gates: they are fixed rules, so validate selects and test confirms).
//
//   node scripts/indicator-lab.js [--days 60] [--step 6] [--horizon 72]
//
// Read-only. Uses coin-labels.json; writes .backtest-cache/indicators.json.
import "../envcrypt.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { classifyRegime, pickShape } from "../standalone/regime.js";
import { realizedVolatility } from "../standalone/meteora.js";
import { INDICATOR_GATES, INDICATOR_EXITS } from "../standalone/indicators.js";
import { simulateEpisode } from "./backtest-sim.js";
import { loadHistory, cacheDir, hourNowSec } from "./history.js";
import { hourlyIndicatorFeatures as features } from "./lab-data.js";
import { getPool } from "../standalone/meteora.js";

const { values: flags } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    horizon: { type: "string", default: "72" },
    step: { type: "string", default: "6" },
    "swap-fee": { type: "string", default: "0.6" },
    "tx-cost-sol": { type: "string", default: "0.001" },
  },
});
const days = Number(flags.days), horizon = Number(flags.horizon), step = Number(flags.step);
const m = config.management;
const costs = { swapFeePct: Number(flags["swap-fee"]), txCostPct: Number(flags["tx-cost-sol"]) / Math.max(m.deployAmountSol, 0.1) * 100 };
const SIM_SHAPE = { spot: "spot", curve: "curve", bid_ask: "bidask" };
const GROUP = { wrapped: "calm", defi_bluechip: "calm", calm: "calm", volatile: "volatile", meme: "volatile" };
const fmt = (n, d = 2) => (n >= 0 ? " " : "") + n.toFixed(d);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// Same gate/exit definitions the bot uses.
const GATES = INDICATOR_GATES;
const EXITS = Object.fromEntries(Object.entries(INDICATOR_EXITS).map(([k, fn]) => [k, k === "none" ? null : fn]));

// ─── Episodes ────────────────────────────────────────────────────────────────
const endSec = hourNowSec();
const episodes = [];
const bounds = { calm: { vol: [], swing: [], value: [] }, volatile: { vol: [], swing: [], value: [] } };
for (const [mint, coin] of Object.entries(config.strategy.coinLabels)) {
  const group = GROUP[coin.label];
  if (!group || !coin.pool) continue;
  const pool = await getPool(coin.pool).catch(() => null);
  if (!pool) continue;
  const { candles, lpFees } = await loadHistory(pool.address, { days, endSec });
  const f = features(candles);
  const tier = config.screening.tiers[(pool.token_x.market_cap ?? 0) >= config.screening.tiers.bluechip.minMcap ? "bluechip" : "midcap"];
  const binStep = pool.pool_config.bin_step;
  for (let i = 96; i + horizon < candles.length; i += step) {
    const regime = classifyRegime(candles, i, config.strategy.regimeThresholds);
    const vol = regime?.vol24 ?? realizedVolatility(candles.slice(i - 24, i + 1));
    if (!(vol > 0)) continue;
    const pick = pickShape(regime, config.strategy, coin.label);
    if (pick.shape === "skip") continue;
    const params = {
      rangeVolMult: pick.overrides.rangeVolMult ?? tier.rangeVolMult,
      stopLossPct: "stopLossPct" in pick.overrides ? pick.overrides.stopLossPct : tier.stopLossPct,
      outOfRangeWaitMinutes: pick.overrides.outOfRangeWaitMinutes ?? m.outOfRangeWaitMinutes,
      takeProfitPct: null, outOfRangeBinsToClose: m.outOfRangeBinsToClose, minFeePerTvl24h: null, minAgeBeforeYieldCheck: m.minAgeBeforeYieldCheck, belowRangeWaitMinutes: null,
    };
    const sim = (over = {}) => simulateEpisode({ candles, lpFees, tvl: pool.tvl, binStep, i0: i, strategy: { side: "below", shape: SIM_SHAPE[over.shape ?? pick.shape] }, vol: over.vol ?? vol, params, costs, horizonHours: horizon, exitAt: over.exitAt ?? null }).pnlPct;
    const exits = Object.fromEntries(Object.entries(EXITS).map(([name, pred]) => [name, sim({ exitAt: pred ? j => pred(f[j]) : null })]));
    const widths = {
      vol: exits.none,
      atr: f[i].atrPct1 ? sim({ vol: f[i].atrPct1 * Math.sqrt(24) }) : exits.none,   // same multiplier on ATR-implied daily move
      swing: f[i].swingPct ? sim({ vol: f[i].swingPct / params.rangeVolMult * 2 }) : exits.none, // range = 2 × median swing
    };
    const pos = f[i].er4?.position;
    const skew = pos == null ? exits.none : pos > 0.7 ? 0 : pos < 0.3 ? sim({ shape: "bid_ask" }) : exits.none;
    episodes.push({ group, symbol: coin.symbol, ts: candles[i].timestamp, f: f[i], exits, widths, skew });
    // Range-bound check: share of the next horizon's closes inside each candidate band.
    const p0 = candles[i].close, next = candles.slice(i + 1, i + 1 + horizon).map(c => c.close);
    const share = (lo, hi) => next.filter(p => p >= lo && p <= hi).length / next.length * 100;
    const past = candles.slice(i - 71, i + 1);
    const sorted = past.map(c => c.close).sort((a, b) => a - b);
    bounds[group].vol.push(share(p0 * (1 - params.rangeVolMult * vol / 100), p0 * (1 + params.rangeVolMult * vol / 100)));
    bounds[group].swing.push(share(Math.min(...past.map(c => c.low)), Math.max(...past.map(c => c.high))));
    bounds[group].value.push(share(sorted[Math.floor(sorted.length * 0.15)], sorted[Math.floor(sorted.length * 0.85)]));
  }
}

// ─── Score: validate picks, test confirms ───────────────────────────────────
const times = [...new Set(episodes.map(e => e.ts))].sort((a, b) => a - b);
const at = q => times[Math.floor(times.length * q)];
const validate = episodes.filter(e => e.ts < at(0.6)), test = episodes.filter(e => e.ts >= at(0.6) + horizon * 3600);
const day = s => new Date(s * 1000).toISOString().slice(0, 10);
console.log(`Episodes ${episodes.length} | validate ${validate.length} (<${day(at(0.6))}) · test ${test.length}`);
const score = (set, gate, exit) => mean(set.map(e => GATES[gate](e.f) ? e.exits[exit] : 0));
const traded = (set, gate) => set.filter(e => GATES[gate](e.f)).length;

const report = {};
for (const group of ["calm", "volatile"]) {
  const v = validate.filter(e => e.group === group), t = test.filter(e => e.group === group);
  if (!v.length || !t.length) continue;
  const base = { v: score(v, "none", "none"), t: score(t, "none", "none") };
  const combos = Object.keys(GATES).flatMap(g => Object.keys(EXITS).map(x => ({ g, x, v: score(v, g, x), t: score(t, g, x), n: traded(t, g) }))).sort((a, b) => b.v - a.v);
  console.log(`\n[${group}] ${[...new Set(episodes.filter(e => e.group === group).map(e => e.symbol))].join(", ")}`);
  console.log(`  today (no indicator): validate ${fmt(base.v)}  test ${fmt(base.t)}  (%/72h episode, n test ${t.length})`);
  console.log(`  gate × exit, top 8 by validate:`);
  for (const c of combos.slice(0, 8)) console.log(`    ${c.g.padEnd(22)} + exit ${c.x.padEnd(16)} validate ${fmt(c.v)}  test ${fmt(c.t)}  traded ${c.n}/${t.length}${c.v > base.v && c.t > base.t ? "  ✓ beats today on both" : ""}`);
  const onlyGates = Object.keys(GATES).map(g => `${g} ${fmt(score(t, g, "none"))}`).join(" · ");
  const onlyExits = Object.keys(EXITS).map(x => `${x} ${fmt(score(t, "none", x))}`).join(" · ");
  console.log(`  test, gates alone: ${onlyGates}`);
  console.log(`  test, exits alone: ${onlyExits}`);
  const w = k => ({ v: mean(v.map(e => e.widths[k])), t: mean(t.map(e => e.widths[k])) });
  console.log(`  range width — vol: ${fmt(w("vol").v)}/${fmt(w("vol").t)}  atr: ${fmt(w("atr").v)}/${fmt(w("atr").t)}  swing: ${fmt(w("swing").v)}/${fmt(w("swing").t)}  (validate/test)`);
  console.log(`  position skew — validate ${fmt(mean(v.map(e => e.skew)))}  test ${fmt(mean(t.map(e => e.skew)))}`);
  const b = bounds[group];
  console.log(`  range bounds, % of next ${horizon}h inside — vol range ${mean(b.vol).toFixed(0)}% · 72h swing hi/lo ${mean(b.swing).toFixed(0)}% · 70% value area ${mean(b.value).toFixed(0)}%`);
  const winner = combos.find(c => c.v > base.v && c.t > base.t && !(c.g === "none" && c.x === "none"));
  report[group] = { base, best: combos[0], winner: winner ?? null, widths: { vol: w("vol"), atr: w("atr"), swing: w("swing") }, skew: { v: mean(v.map(e => e.skew)), t: mean(t.map(e => e.skew)) }, bounds: Object.fromEntries(Object.entries(b).map(([k, xs]) => [k, mean(xs)])) };
  console.log(`  → ${winner ? `winner: gate ${winner.g} + exit ${winner.x} (validate ${fmt(winner.v)}, test ${fmt(winner.t)} vs today ${fmt(base.t)})` : "no gate/exit beats today on both validate and test"}`);
}
fs.writeFileSync(path.join(cacheDir, "indicators.json"), JSON.stringify({ generatedAt: new Date().toISOString(), days, horizon, step, costs, report }, null, 2));
console.log(`\nCaveats: overlapping episodes; TVL fixed; fee share model × 1; coins = coin-labels.json pools. Saved .backtest-cache/indicators.json`);
