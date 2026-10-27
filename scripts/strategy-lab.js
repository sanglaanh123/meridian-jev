#!/usr/bin/env node
// Strategy lab: which DLMM position (shape × side) works in which market regime,
// and does a learned policy — optionally using Jev's token classification as a
// feature — beat "always do what the bot does today" on unseen time?
//
//   node scripts/strategy-lab.js [--days 60] [--max-pools 30] [--horizon 72] [--no-jev] [--refresh]
//
// Read-only: Meteora + Jupiter (+ Jev when TYPESAFE_API_KEY is set). Writes only
// to .backtest-cache/ (git-ignored).
import "../envcrypt.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { judgeToken, CATEGORIES } from "../standalone/judgment.js";
import { STRATEGIES, classifyRegime, simulateEpisode } from "./backtest-sim.js";
import { learnPolicy, choose, evaluate, SKIP } from "./policy.js";
import { loadHistory, cacheDir, hourNowSec } from "./history.js";
import { buildUniverse } from "./lab-data.js";

const { values: flags } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    "max-pools": { type: "string", default: "30" },
    horizon: { type: "string", default: "72" },
    step: { type: "string", default: "6" },
    concentration: { type: "string", default: "1" },
    "swap-fee": { type: "string", default: "0.6" },
    "tx-cost-sol": { type: "string", default: "0.001" },
    "no-jev": { type: "boolean", default: false },
    "skip-below": { type: "string", default: "-1" },  // suggest "skip" when the best one-sided shape loses more than this per episode
    refresh: { type: "boolean", default: false },
  },
});
const days = Number(flags.days), horizon = Number(flags.horizon), step = Number(flags.step);
const m = config.management;
const costs = { swapFeePct: Number(flags["swap-fee"]), txCostPct: Number(flags["tx-cost-sol"]) / Math.max(m.deployAmountSol, 0.1) * 100 };
const endSec = hourNowSec();
const fmt = (n, d = 2) => (n >= 0 ? " " : "") + n.toFixed(d);

// ─── Universe: verified tier tokens with a liquid SOL pool ───────────────────
const universe = await buildUniverse({ maxPools: Number(flags["max-pools"]) });
console.log(`Universe: ${universe.length} pools — ${universe.map(u => `${u.symbol}[${u.tier}]`).join(", ")}`);

// ─── Jev features (text only), cached per mint ──────────────────────────────
const jevFile = path.join(cacheDir, "jev-features.json");
fs.mkdirSync(cacheDir, { recursive: true });
const jevCache = fs.existsSync(jevFile) ? JSON.parse(fs.readFileSync(jevFile, "utf8")) : {};
const useJev = !flags["no-jev"] && !!process.env.TYPESAFE_API_KEY;
if (useJev && config.jev.mode === "off") config.jev.mode = "shadow"; // judgeToken only runs when Jev is on
for (const u of universe) {
  if (useJev && !jevCache[u.mint]) {
    try {
      const j = await judgeToken(u.token, Object.keys(CATEGORIES));
      jevCache[u.mint] = { category: j.answers.category.choice ?? "unknown", established: j.answers.established.noul, impersonation: j.answers.impersonation.noul };
    } catch (e) { console.log(`  Jev failed for ${u.symbol}: ${e.message}`); }
  }
  u.jev = jevCache[u.mint] ?? null;
}
fs.writeFileSync(jevFile, JSON.stringify(jevCache, null, 2));
if (useJev) console.log(`Jev: ${universe.map(u => `${u.symbol}=${u.jev?.category ?? "?"}(${u.jev ? u.jev.established.toFixed(2) : "?"})`).join(", ")}`);
else console.log("Jev: off (no TYPESAFE_API_KEY or --no-jev) — category feature = unknown");

// ─── Episodes ────────────────────────────────────────────────────────────────
const rows = [];
for (const u of universe) {
  const { candles, lpFees } = await loadHistory(u.pool.address, { days, endSec, refresh: flags.refresh });
  const t = config.screening.tiers[u.tier];
  const params = { rangeVolMult: t.rangeVolMult, stopLossPct: t.stopLossPct, takeProfitPct: null, outOfRangeWaitMinutes: m.outOfRangeWaitMinutes, outOfRangeBinsToClose: m.outOfRangeBinsToClose, minFeePerTvl24h: null, minAgeBeforeYieldCheck: m.minAgeBeforeYieldCheck, belowRangeWaitMinutes: null };
  for (let i = 72; i + horizon < candles.length; i += step) {
    const regime = classifyRegime(candles, i);
    if (!regime) continue;
    const fee24 = lpFees.slice(i - 23, i + 1).reduce((a, b) => a + b, 0) / u.pool.tvl * 100;
    if (fee24 < 0.01) continue; // the scanner would never offer a dead pool
    const returns = {};
    for (const s of STRATEGIES) returns[s.id] = simulateEpisode({ candles, lpFees, tvl: u.pool.tvl, binStep: u.pool.pool_config.bin_step, i0: i, strategy: s, vol: regime.vol24, params, costs, concentration: Number(flags.concentration), horizonHours: horizon }).pnlPct;
    rows.push({
      symbol: u.symbol, ts: candles[i].timestamp, returns,
      features: { trend: regime.trend, vol: regime.vol, tier: u.tier, fee: fee24 < 0.1 ? "low" : fee24 < 0.5 ? "mid" : "high", category: u.jev?.category ?? "unknown" },
    });
  }
}
console.log(`Episodes: ${rows.length} (every ${step}h, ${horizon}h horizon, ${STRATEGIES.length} strategies each)`);
if (!rows.length) process.exit(0);

// ─── Part 1: strategy × regime (all data) ────────────────────────────────────
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`\nMean return per ${horizon}h episode (%), by regime — skip = 0`);
console.log(`${"regime".padEnd(18)} ${"n".padStart(5)}  ${STRATEGIES.map(s => s.id.padStart(10)).join(" ")}   best`);
const regimes = [...new Set(rows.map(r => `${r.features.trend}/${r.features.vol}`))].sort();
for (const key of regimes) {
  const group = rows.filter(r => `${r.features.trend}/${r.features.vol}` === key);
  const means = STRATEGIES.map(s => mean(group.map(r => r.returns[s.id])));
  const best = Math.max(...means);
  console.log(`${key.padEnd(18)} ${String(group.length).padStart(5)}  ${means.map(x => fmt(x).padStart(10)).join(" ")}   ${best > 0 ? STRATEGIES[means.indexOf(best)].id : SKIP}`);
}

// The bot only deploys one-sided SOL; suggest its regimeStrategies from those shapes.
const SHAPE_OF = { bid_spot: "spot", bid_curve: "curve", bid_bidask: "bid_ask" };
const suggested = {};
for (const key of regimes) {
  const group = rows.filter(r => `${r.features.trend}/${r.features.vol}` === key);
  const best = Object.keys(SHAPE_OF).map(id => ({ id, m: mean(group.map(r => r.returns[id])) })).sort((a, b) => b.m - a.m)[0];
  suggested[key] = best.m < Number(flags["skip-below"]) ? "skip" : SHAPE_OF[best.id];
}
console.log(`
Suggested user-config "regimeStrategies" (one-sided SOL; skip below ${flags["skip-below"]}%/episode):
${JSON.stringify(suggested)}`);

// ─── Part 2: learn on early time, test on later time ─────────────────────────
const times = [...new Set(rows.map(r => r.ts))].sort((a, b) => a - b);
const cut = times[Math.floor(times.length * 0.7)];
const train = rows.filter(r => r.ts < cut - horizon * 3600); // gap: train episodes end before test starts
const test = rows.filter(r => r.ts >= cut);
console.log(`\nTime split: train ${train.length} episodes before ${new Date((cut - horizon * 3600) * 1000).toISOString().slice(0, 10)}, test ${test.length} from ${new Date(cut * 1000).toISOString().slice(0, 10)}`);
const variants = {
  "numeric (trend, vol)": [["trend", "vol"], ["trend"], []],
  "numeric + fee": [["trend", "vol", "fee"], ["trend", "vol"], ["trend"], []],
  "numeric + tier": [["trend", "vol", "tier"], ["trend", "vol"], ["trend"], []],
  "numeric + Jev category": [["trend", "vol", "category"], ["trend", "category"], ["trend", "vol"], ["trend"], []],
};
const bestSingle = STRATEGIES.map(s => ({ id: s.id, m: mean(train.map(r => r.returns[s.id])) })).sort((a, b) => b.m - a.m)[0];
const results = [
  ["skip everything (hold SOL)", evaluate(test, () => SKIP)],
  ["always bid_spot (bot today)", evaluate(test, () => "bid_spot")],
  [`always ${bestSingle.id} (best on train)`, evaluate(test, () => bestSingle.m > 0 ? bestSingle.id : SKIP)],
];
const policies = {};
for (const [name, levels] of Object.entries(variants)) {
  const policy = learnPolicy(train, { levels, minSamples: 15 });
  policies[name] = policy;
  results.push([`policy: ${name}`, evaluate(test, r => choose(policy, r.features))]);
}
results.push(["oracle (best in hindsight, upper bound)", evaluate(test, r => { const best = Object.entries(r.returns).sort((a, b) => b[1] - a[1])[0]; return best[1] > 0 ? best[0] : SKIP; })]);
console.log(`${"".padEnd(42)} ${"mean/ep".padStart(8)} ${"traded".padStart(7)} ${"win%".padStart(6)} ${"mean if traded".padStart(15)}`);
for (const [name, r] of results) console.log(`${name.padEnd(42)} ${fmt(r.mean).padStart(8)} ${String(r.traded).padStart(7)} ${r.winRate.toFixed(0).padStart(6)} ${fmt(r.tradedMean).padStart(15)}`);

// Save the Jev-aware policy retrained on all data, with its test score, for review.
const finalLevels = useJev ? variants["numeric + Jev category"] : variants["numeric (trend, vol)"];
const finalPolicy = learnPolicy(rows, { levels: finalLevels, minSamples: 15 });
fs.writeFileSync(path.join(cacheDir, "policy.json"), JSON.stringify({ generatedAt: new Date().toISOString(), days, horizon, costs, regimeStrategies: suggested, test: Object.fromEntries(results), policy: finalPolicy }, null, 2));
console.log(`\nPolicy table (all data, ${useJev ? "with" : "without"} Jev category):`);
for (const [key, v] of Object.entries(finalPolicy.table).sort()) console.log(`  ${key.padEnd(44)} → ${v.pick.padEnd(10)} mean ${fmt(v.mean)}  n ${v.n}`);
console.log(`\nCaveats: universe = today's pools (survivorship); TVL fixed at today's value; episodes overlap (every ${step}h, ${horizon}h long) so n overstates independence; fee share model × ${flags.concentration}. Saved .backtest-cache/policy.json`);
