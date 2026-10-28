#!/usr/bin/env node
// Would auto-rebalancing (HawkFi "HFL"-style) beat the bot's close-and-re-enter?
// Inspired by K.S. Louie's paper test of HawkFi HFL Regular on SOL-USDC (Oct 2026):
// 14 bins, swapless rebalance the moment price leaves the range, 0 cooldown —
// 2,201 rebalances in two weeks, fees +0.675 SOL, still −0.29 SOL vs holding,
// because each swapless re-centre locks impermanent loss in.
//
// For every labeled coin pool: simulate the bot's current label strategy and
// rebalancing variants over the same 7-day windows; pick on validate, report test.
//
//   node scripts/rebalance-lab.js [--days 60] [--step 24] [--horizon 168] [--rebalance-cost-sol 0.0002]
//
// Read-only. Uses coin-labels.json; writes .backtest-cache/rebalance.json.
import "../envcrypt.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { classifyRegime, pickShape } from "../standalone/regime.js";
import { getPool, realizedVolatility } from "../standalone/meteora.js";
import { INDICATOR_GATES } from "../standalone/indicators.js";
import { simulateEpisode, simulateRebalancer } from "./backtest-sim.js";
import { loadHistory, cacheDir, hourNowSec } from "./history.js";
import { hourlyIndicatorFeatures } from "./lab-data.js";

const { values: flags } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    horizon: { type: "string", default: "168" },
    step: { type: "string", default: "24" },
    "swap-fee": { type: "string", default: "0.6" },
    "tx-cost-sol": { type: "string", default: "0.001" },
    "rebalance-cost-sol": { type: "string", default: "0.0002" },
  },
});
const days = Number(flags.days), horizon = Number(flags.horizon), step = Number(flags.step);
const m = config.management;
const sizeSol = Math.max(m.deployAmountSol, 0.1);
const costs = { swapFeePct: Number(flags["swap-fee"]), txCostPct: Number(flags["tx-cost-sol"]) / sizeSol * 100 };
const rebalanceCostPct = Number(flags["rebalance-cost-sol"]) / sizeSol * 100;
const SIM_SHAPE = { spot: "spot", curve: "curve", bid_ask: "bidask" };
const GROUP = { wrapped: "calm", defi_bluechip: "calm", calm: "calm", volatile: "volatile", meme: "volatile" };
const fmt = (n, d = 2) => (n >= 0 ? " " : "") + n.toFixed(d);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// HawkFi HFL Regular as documented, then a grid around it.
const VARIANTS = { hfl_regular: { start: "two", mode: "swapless", bins: 14, rebalanceBins: 12, cooldownHours: 0, stopDropPct: 20, feeCutPct: 8 } };
for (const start of ["two", "sol"])
  for (const mode of ["swapless", "swap"])
    for (const bins of [14, 35, 69])
      for (const cooldownHours of [0, 4, 24])
        for (const stopDropPct of [20, null])
          VARIANTS[`${start}/${mode}/${bins}b/cd${cooldownHours}h/stop${stopDropPct ?? "off"}`] = { start, mode, bins, rebalanceBins: bins, cooldownHours, stopDropPct, feeCutPct: 0 };

const endSec = hourNowSec();
const rows = [];
for (const [, coin] of Object.entries(config.strategy.coinLabels)) {
  const group = GROUP[coin.label];
  if (!group || !coin.pool) continue;
  const pool = await getPool(coin.pool).catch(() => null);
  if (!pool) continue;
  const { candles, lpFees } = await loadHistory(pool.address, { days, endSec });
  const f = hourlyIndicatorFeatures(candles);
  const tier = config.screening.tiers[(pool.token_x.market_cap ?? 0) >= config.screening.tiers.bluechip.minMcap ? "bluechip" : "midcap"];
  const binStep = pool.pool_config.bin_step;
  const gate = (config.strategy.labelIndicators[coin.label] ?? { gate: "none" }).gate;
  for (let i = 96; i + horizon < candles.length; i += step) {
    const regime = classifyRegime(candles, i, config.strategy.regimeThresholds);
    const vol = regime?.vol24 ?? realizedVolatility(candles.slice(i - 24, i + 1));
    if (!(vol > 0)) continue;
    const pick = pickShape(regime, config.strategy, coin.label);
    const params = {
      rangeVolMult: pick.overrides.rangeVolMult ?? tier.rangeVolMult,
      stopLossPct: "stopLossPct" in pick.overrides ? pick.overrides.stopLossPct : tier.stopLossPct,
      outOfRangeWaitMinutes: pick.overrides.outOfRangeWaitMinutes ?? m.outOfRangeWaitMinutes,
      takeProfitPct: null, outOfRangeBinsToClose: m.outOfRangeBinsToClose, minFeePerTvl24h: null, minAgeBeforeYieldCheck: m.minAgeBeforeYieldCheck, belowRangeWaitMinutes: null,
    };
    const gateOpen = INDICATOR_GATES[gate](f[i]);
    // Bot today: label strategy, gated by its indicator, held up to the horizon (one position, no re-entry).
    const bot = pick.shape === "skip" || !gateOpen ? 0 : simulateEpisode({ candles, lpFees, tvl: pool.tvl, binStep, i0: i, strategy: { side: "below", shape: SIM_SHAPE[pick.shape] }, vol, params, costs, horizonHours: horizon }).pnlPct;
    const reb = {};
    for (const [name, v] of Object.entries(VARIANTS)) reb[name] = simulateRebalancer({ candles, lpFees, tvl: pool.tvl, binStep, i0: i, horizonHours: horizon, ...v, rebalanceCostPct, costs });
    rows.push({ group, symbol: coin.symbol, binStep, ts: candles[i].timestamp, gateOpen, bot, reb, priceMovePct: (candles[i + horizon].close / candles[i].close - 1) * 100 });
  }
}
const times = [...new Set(rows.map(r => r.ts))].sort((a, b) => a - b);
const cut = times[Math.floor(times.length * 0.6)];
const validate = rows.filter(r => r.ts < cut - horizon * 3600), test = rows.filter(r => r.ts >= cut);
console.log(`Windows: ${rows.length} × ${horizon}h | validate ${validate.length} · test ${test.length} (from ${new Date(cut * 1000).toISOString().slice(0, 10)}) | rebalance cost ${rebalanceCostPct.toFixed(3)}%, swap ${costs.swapFeePct}%`);

const report = {};
for (const group of ["calm", "volatile"]) {
  const v = validate.filter(r => r.group === group), t = test.filter(r => r.group === group), all = rows.filter(r => r.group === group);
  if (!v.length || !t.length) continue;
  const stat = (set, name) => ({
    pnl: mean(set.map(r => r.reb[name].pnlPct)), vsMix: mean(set.map(r => r.reb[name].vsHoldMixPct)), fees: mean(set.map(r => r.reb[name].feesPct)),
    perDay: mean(set.map(r => r.reb[name].rebalances / Math.max(1, r.reb[name].hours) * 24)),
  });
  const gatedStat = (set, name) => mean(set.map(r => r.gateOpen ? r.reb[name].pnlPct : 0));
  const hfl = stat(all, "hfl_regular");
  console.log(`\n[${group}] ${[...new Set(all.map(r => `${r.symbol}(bin ${r.binStep})`))].join(", ")} — avg ${horizon}h price move ${fmt(mean(all.map(r => r.priceMovePct)))}%`);
  console.log(`  HawkFi HFL Regular (14 bins, swapless, cooldown 0, −20% stop, 8% fee cut), all windows:`);
  console.log(`    vs hold SOL ${fmt(hfl.pnl)}% · vs hold start mix ${fmt(hfl.vsMix)}% · fees ${fmt(hfl.fees)}% · ${hfl.perDay.toFixed(1)} rebalances/day`);
  console.log(`  bot today (label strategy + indicator gate, no rebalance): validate ${fmt(mean(v.map(r => r.bot)))}  test ${fmt(mean(t.map(r => r.bot)))}  %/${horizon}h vs hold SOL`);
  const ranked = Object.keys(VARIANTS).map(name => ({ name, v: stat(v, name).pnl, t: stat(t, name), gv: gatedStat(v, name), gt: gatedStat(t, name) })).sort((a, b) => b.v - a.v);
  console.log(`  rebalancing variants, top 6 by validate (vs hold SOL; 'gated' = only when the label's indicator gate is open):`);
  for (const r of ranked.slice(0, 6)) console.log(`    ${r.name.padEnd(36)} validate ${fmt(r.v)}  test ${fmt(r.t.pnl)} (vs mix ${fmt(r.t.vsMix)}, fees ${fmt(r.t.fees)}, ${r.t.perDay.toFixed(1)}/day)  gated test ${fmt(r.gt)}`);
  const best = ranked[0];
  const botTest = mean(t.map(r => r.bot));
  console.log(`  → best rebalancer on validate: ${best.name}: test ${fmt(best.t.pnl)} (gated ${fmt(best.gt)}) vs bot today ${fmt(botTest)}`);
  report[group] = { hfl, botTest, best: { name: best.name, validate: best.v, test: best.t, gatedTest: best.gt }, top: ranked.slice(0, 10).map(r => ({ name: r.name, validate: r.v, test: r.t.pnl, gatedTest: r.gt })) };
}
fs.writeFileSync(path.join(cacheDir, "rebalance.json"), JSON.stringify({ generatedAt: new Date().toISOString(), days, horizon, step, costs, rebalanceCostPct, report }, null, 2));
console.log(`\nCaveats: hourly candles (a per-minute bot rebalances more often, so swapless churn is understated); TVL fixed; fee share × 1; overlapping 7-day windows. Saved .backtest-cache/rebalance.json`);
