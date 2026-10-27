#!/usr/bin/env node
// Which pool (bin step) should each coin label farm? For every labeled coin with
// several SOL pools, simulate the label's strategy on each pool at the same
// moments, then compare pool-choice rules per label: fit on early time, test later.
//
//   node scripts/binstep-lab.js [--days 60] [--step 12] [--min-tvl 20000]
//
// Read-only (Meteora). Uses coin-labels.json; writes .backtest-cache/binstep.json.
import "../envcrypt.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { poolsForMint } from "../standalone/meteora.js";
import { classifyRegime, pickShape } from "../standalone/regime.js";
import { realizedVolatility } from "../standalone/meteora.js";
import { fittedBinStep } from "../standalone/screening.js";
import { simulateEpisode, binsForMove } from "./backtest-sim.js";
import { loadHistory, cacheDir, hourNowSec } from "./history.js";

const { values: flags } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    horizon: { type: "string", default: "72" },
    step: { type: "string", default: "12" },
    "min-tvl": { type: "string", default: "20000" },
    "swap-fee": { type: "string", default: "0.6" },
    "tx-cost-sol": { type: "string", default: "0.001" },
  },
});
const days = Number(flags.days), horizon = Number(flags.horizon), step = Number(flags.step);
const m = config.management;
const costs = { swapFeePct: Number(flags["swap-fee"]), txCostPct: Number(flags["tx-cost-sol"]) / Math.max(m.deployAmountSol, 0.1) * 100 };
const SIM_SHAPE = { spot: "spot", curve: "curve", bid_ask: "bidask" };
const fmt = (n, d = 2) => (n >= 0 ? " " : "") + n.toFixed(d);
const endSec = hourNowSec();


// Pool-choice rules: each picks one pool from the candidates at a moment (no look-ahead).
const RULES = {
  tvl: c => c.sort((a, b) => b.tvl - a.tvl)[0],
  fee24: c => c.sort((a, b) => b.fee24 - a.fee24)[0],                                  // what the bot does today
  fit: c => c.sort((a, b) => Math.abs(Math.log(a.binStep / a.fitStep)) - Math.abs(Math.log(b.binStep / b.fitStep)))[0],
  smallest: c => c.sort((a, b) => a.binStep - b.binStep || b.tvl - a.tvl)[0],
  largest: c => c.sort((a, b) => b.binStep - a.binStep || b.tvl - a.tvl)[0],
};

const labels = config.strategy.coinLabels;
const moments = []; // { label, symbol, ts, options: [{ pool, binStep, tvl, fee24, fitStep, pnl }] }
for (const [mint, coin] of Object.entries(labels)) {
  const pools = (await poolsForMint(mint)).filter(p => p.tvl >= Number(flags["min-tvl"])).slice(0, 6);
  if (pools.length < 2) continue;
  const hist = [];
  for (const p of pools) hist.push({ p, ...(await loadHistory(p.address, { days, endSec })) });
  const byTs = hist.map(h => new Map(h.candles.map((c, i) => [c.timestamp, i])));
  const times = [...byTs[0].keys()].filter(ts => byTs.every(map => map.has(ts))).sort((a, b) => a - b);
  for (let k = 72; k + horizon < times.length; k += step) {
    const options = [];
    for (let j = 0; j < hist.length; j++) {
      const { p, candles, lpFees } = hist[j];
      const i = byTs[j].get(times[k]);
      if (i < 72 || i + horizon >= candles.length) continue;
      const regime = classifyRegime(candles, i, config.strategy.regimeThresholds);
      const vol = regime?.vol24 ?? realizedVolatility(candles.slice(i - 24, i + 1));
      if (!(vol > 0)) continue;
      const pick = pickShape(regime, config.strategy, coin.label);
      if (pick.shape === "skip") continue;
      const t = config.screening.tiers[p.token_x.market_cap >= config.screening.tiers.bluechip.minMcap ? "bluechip" : "midcap"];
      const params = {
        rangeVolMult: pick.overrides.rangeVolMult ?? t.rangeVolMult,
        stopLossPct: "stopLossPct" in pick.overrides ? pick.overrides.stopLossPct : t.stopLossPct,
        outOfRangeWaitMinutes: pick.overrides.outOfRangeWaitMinutes ?? m.outOfRangeWaitMinutes,
        takeProfitPct: null, outOfRangeBinsToClose: m.outOfRangeBinsToClose, minFeePerTvl24h: null, minAgeBeforeYieldCheck: m.minAgeBeforeYieldCheck, belowRangeWaitMinutes: null,
      };
      const binStep = p.pool_config.bin_step;
      const pnl = simulateEpisode({ candles, lpFees, tvl: p.tvl, binStep, i0: i, strategy: { side: "below", shape: SIM_SHAPE[pick.shape] }, vol, params, costs, horizonHours: horizon }).pnlPct;
      const fee24 = lpFees.slice(i - 23, i + 1).reduce((a, b) => a + b, 0) / p.tvl * 100;
      options.push({ pool: p.address, binStep, tvl: p.tvl, fee24, fitStep: Math.max(1, fittedBinStep(params.rangeVolMult * vol)), bins: binsForMove(params.rangeVolMult * vol, binStep), pnl });
    }
    if (options.length >= 2) moments.push({ label: coin.label, symbol: coin.symbol, ts: times[k], options });
  }
  console.log(`${coin.symbol.padEnd(8)} ${coin.label.padEnd(14)} pools: ${pools.map(p => `bin${p.pool_config.bin_step}`).join(", ")}`);
}
if (!moments.length) { console.log("No labeled coin has two pools with history."); process.exit(0); }

const allTs = [...new Set(moments.map(x => x.ts))].sort((a, b) => a - b);
const cut = allTs[Math.floor(allTs.length * 0.7)];
const fit = moments.filter(x => x.ts < cut - horizon * 3600), test = moments.filter(x => x.ts >= cut);
const score = (set, rule) => set.length ? set.reduce((a, x) => a + RULES[rule]([...x.options]).pnl, 0) / set.length : NaN;
const oracle = set => set.length ? set.reduce((a, x) => a + Math.max(...x.options.map(o => o.pnl)), 0) / set.length : NaN;

const result = {};
console.log(`\nMean return per ${horizon}h episode (%) by pool-choice rule — fit ${fit.length} / test ${test.length} moments (test from ${new Date(cut * 1000).toISOString().slice(0, 10)})`);
console.log(`${"label".padEnd(15)}${"coins".padEnd(28)}${Object.keys(RULES).map(r => r.padStart(9)).join("")}${"oracle".padStart(9)}  pick (by fit) → test`);
for (const label of [...new Set(moments.map(x => x.label))]) {
  const f = fit.filter(x => x.label === label), t = test.filter(x => x.label === label);
  const fitScores = Object.fromEntries(Object.keys(RULES).map(r => [r, score(f, r)]));
  const best = Object.entries(fitScores).sort((a, b) => b[1] - a[1])[0][0];
  const coins = [...new Set(moments.filter(x => x.label === label).map(x => x.symbol))].join(",");
  console.log(`${label.padEnd(15)}${coins.slice(0, 27).padEnd(28)}${Object.keys(RULES).map(r => fmt(score(t, r)).padStart(9)).join("")}${fmt(oracle(t)).padStart(9)}  ${best} → ${fmt(score(t, best))} (fee24 today ${fmt(score(t, "fee24"))})`);
  result[label] = { rule: best, fit: fitScores, test: Object.fromEntries(Object.keys(RULES).map(r => [r, score(t, r)])), oracle: oracle(t), coins };
}
console.log("(columns show the test period; 'pick' is chosen on the fit period only)");
fs.writeFileSync(path.join(cacheDir, "binstep.json"), JSON.stringify({ generatedAt: new Date().toISOString(), days, horizon, costs, result }, null, 2));
console.log(`\nfit rule: bin step whose ${config.strategy.minBinsBelow}-bin floor spans rangeVolMult × daily vol. Caveats: few coins per label, TVL fixed at today's value, small pools' fee share is modelled like large ones. Saved .backtest-cache/binstep.json`);
