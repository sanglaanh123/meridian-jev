#!/usr/bin/env node
// Backtest the scanner's tier rules + exit rules on Meteora hourly history and
// grid-search the exit/range parameters per tier. Read-only: Meteora + Jupiter only.
//
//   node scripts/backtest.js [--days 30] [--concentration 1] [--swap-fee 0.6] [--tx-cost-sol 0.001] [--refresh]
//
// Caveats printed with every report: survivorship (universe = pools that qualify
// today), constant TVL (today's), and the fee-share model (`concentration`).
import "../envcrypt.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { listPools } from "../standalone/meteora.js";
import { loadHistory, cacheDir, hourNowSec } from "./history.js";
import { fetchJson } from "../standalone/rpc.js";
import { listFilter, preselect } from "../standalone/scanner.js";
import { rejectToken } from "../standalone/screening.js";
import { simulatePool } from "./backtest-sim.js";

const { values: flags } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    concentration: { type: "string", default: "1" },
    "swap-fee": { type: "string", default: "0.6" },     // Jupiter referral 0.5% + ~0.1% slippage
    "tx-cost-sol": { type: "string", default: "0.001" }, // open + close transactions
    refresh: { type: "boolean", default: false },
  },
});
const days = Number(flags.days), concentration = Number(flags.concentration);
const m = config.management;
const positionSol = Math.max(m.deployAmountSol, 0.1);
const costs = { swapFeePct: Number(flags["swap-fee"]), txCostPct: Number(flags["tx-cost-sol"]) / positionSol * 100 };
const endSec = hourNowSec();

// ─── Universe: pools that pass today's tier pool + token rules ───────────────
const pools = await listPools({ filter: listFilter(), sort: "fee_tvl_ratio_24h:desc", pageSize: 200 });
const universe = [];
for (const c of preselect(pools)) {
  const assets = await fetchJson(`https://datapi.jup.ag/v1/assets/search?query=${c.mint}`).catch(() => []);
  const token = (Array.isArray(assets) ? assets : []).find(t => t.id === c.mint);
  if (rejectToken(token, c.mint, config.screening.tiers[c.tier])) continue;
  universe.push({ ...c, pool: pools.find(p => p.address === c.pool), symbol: token.symbol });
}
console.log(`Universe: ${universe.length} pools (${universe.map(u => `${u.symbol}[${u.tier}]`).join(", ")})`);

for (const u of universe) Object.assign(u, await loadHistory(u.pool.address, { days, endSec, refresh: flags.refresh }));

// ─── Grid ────────────────────────────────────────────────────────────────────
const grid = [];
// minTrend24hPct and belowRangeWaitMinutes are research knobs the bot does not have yet.
for (const rangeVolMult of [1.5, 2, 3, 4])
  for (const stopLossPct of [-10, -15, -25, null])
    for (const outOfRangeWaitMinutes of [120, 240, 720])
      for (const minTrend24hPct of [null, -3, 0, 3])
        for (const belowRangeWaitMinutes of [null, 0, 60])
          grid.push({ rangeVolMult, stopLossPct, outOfRangeWaitMinutes, minTrend24hPct, belowRangeWaitMinutes });
const base = {
  takeProfitPct: m.takeProfitPct, outOfRangeBinsToClose: m.outOfRangeBinsToClose,
  minFeePerTvl24h: m.minFeePerTvl24h, minAgeBeforeYieldCheck: m.minAgeBeforeYieldCheck,
  minTrend24hPct: null, belowRangeWaitMinutes: null,
  cooldownHours: config.standalone.cooldownSec / 3600,
};
const median = xs => { const s = [...xs].sort((a, b) => a - b); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const fmt = (n, d = 2) => n == null ? "off" : n.toFixed(d);

function evaluate(tier, members, gridParams) {
  const t = config.screening.tiers[tier];
  const params = { ...base, ...gridParams };
  const runs = members.map(u => ({ u, r: simulatePool({ candles: u.candles, lpFees: u.lpFees, tvl: u.pool.tvl, binStep: u.pool.pool_config.bin_step, tier: t, screening: config.screening, params, costs, concentration }) }));
  const monthly = runs.map(x => x.r.monthlyPct);
  return {
    params, runs,
    median: median(monthly), mean: monthly.reduce((a, b) => a + b, 0) / monthly.length, worst: Math.min(...monthly),
    maxDD: Math.max(...runs.map(x => x.r.maxDrawdownPct)),
    trades: runs.reduce((a, x) => a + x.r.trades.length, 0), stops: runs.reduce((a, x) => a + x.r.stops, 0),
    exposure: runs.reduce((a, x) => a + x.r.exposurePct, 0) / runs.length,
  };
}

const report = { generatedAt: new Date().toISOString(), days, concentration, costs, tiers: {} };
for (const tier of config.screening.enabledTiers) {
  const members = universe.filter(u => u.tier === tier && u.candles.length > 48);
  if (!members.length) { console.log(`\n[${tier}] no pools with history`); continue; }
  const t = config.screening.tiers[tier];
  const current = evaluate(tier, members, { rangeVolMult: t.rangeVolMult, stopLossPct: t.stopLossPct, outOfRangeWaitMinutes: m.outOfRangeWaitMinutes });
  const ranked = grid.map(g => evaluate(tier, members, g)).sort((a, b) => b.median - a.median || b.worst - a.worst);
  const row = e => `range×${fmt(e.params.rangeVolMult, 1).padStart(3)}  stop ${String(fmt(e.params.stopLossPct, 0)).padStart(4)}%  OOR ${String(e.params.outOfRangeWaitMinutes).padStart(3)}m below ${String(fmt(e.params.belowRangeWaitMinutes, 0)).padStart(3)}  trend≥${String(fmt(e.params.minTrend24hPct, 0)).padStart(3)}% | median ${fmt(e.median).padStart(6)}%/mo  mean ${fmt(e.mean).padStart(6)}  worst ${fmt(e.worst).padStart(7)}  maxDD ${fmt(e.maxDD, 1).padStart(5)}%  trades ${e.trades}  stops ${e.stops}  in-pos ${fmt(e.exposure, 0)}%`;
  console.log(`\n[${tier}] ${members.length} pools: ${members.map(u => u.symbol).join(", ")}`);
  console.log(`  current ${row(current)}`);
  ranked.slice(0, 5).forEach((e, i) => console.log(`  #${i + 1}      ${row(e)}`));
  console.log(`  per pool, best config:`);
  for (const { u, r } of ranked[0].runs) console.log(`    ${u.symbol.padEnd(10)} ${fmt(r.monthlyPct).padStart(7)}%/mo  trades ${r.trades.length}  stops ${r.stops}  maxDD ${fmt(r.maxDrawdownPct, 1)}%  in-pos ${fmt(r.exposurePct, 0)}%`);
  report.tiers[tier] = {
    pools: members.map(u => u.symbol), current: { ...current, runs: undefined },
    top: ranked.slice(0, 5).map(e => ({ ...e, runs: undefined })),
  };
}
fs.writeFileSync(path.join(cacheDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nAssumptions: universe = pools qualifying today (survivorship bias); TVL fixed at today's value; fee share = pool LP fee/TVL × ${concentration} while price is inside the range; swap ${costs.swapFeePct}% on the token side at close; tx ${fmt(costs.txCostPct)}% per round trip (${flags["tx-cost-sol"]} SOL on ${positionSol} SOL). Report: .backtest-cache/report.json`);
