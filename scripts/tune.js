#!/usr/bin/env node
// Tune the "auto" strategy on Meteora history without peeking at the test period:
//   fit (first 50% of time) → choose on validate (next 20%) → refit fit+validate → report test (last 30%).
// 1. Regime thresholds (trendPct, lowVol, highVol).
// 2. Per-regime shape + range + stop + OOR wait (one-sided SOL, what the bot deploys).
// 3. Jev text features and the minEstablished gate.
//
//   node scripts/tune.js [--days 60] [--max-pools 30] [--step 12] [--skip-below -1] [--no-jev]
//
// Read-only. Writes .backtest-cache/tuned.json (git-ignored).
import "../envcrypt.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, DEFAULT_REGIME_STRATEGIES } from "../config.js";
import { REGIME_DEFAULTS, classifyRegime } from "../standalone/regime.js";
import { simulateEpisode } from "./backtest-sim.js";
import { learnPolicy, choose, evaluate, SKIP } from "./policy.js";
import { loadHistory, cacheDir, hourNowSec } from "./history.js";
import { buildUniverse, jevFeatures, JEV_QUESTIONS } from "./lab-data.js";

const { values: flags } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    "max-pools": { type: "string", default: "30" },
    horizon: { type: "string", default: "72" },
    step: { type: "string", default: "12" },
    "skip-below": { type: "string", default: "-1" },
    concentration: { type: "string", default: "1" },
    "swap-fee": { type: "string", default: "0.6" },
    "tx-cost-sol": { type: "string", default: "0.001" },
    "no-jev": { type: "boolean", default: false },
    symbols: { type: "string" },  // comma list to tune one group, e.g. the calm (bluechip-like) tokens
    refresh: { type: "boolean", default: false },
  },
});
const days = Number(flags.days), horizon = Number(flags.horizon), step = Number(flags.step), skipBelow = Number(flags["skip-below"]);
const m = config.management;
const costs = { swapFeePct: Number(flags["swap-fee"]), txCostPct: Number(flags["tx-cost-sol"]) / Math.max(m.deployAmountSol, 0.1) * 100 };
const fmt = (n, d = 2) => (n >= 0 ? " " : "") + n.toFixed(d);
const SIM_SHAPE = { spot: "spot", curve: "curve", bid_ask: "bidask" };

// One-sided SOL combos the bot can deploy: shape × range × stop × OOR wait.
const COMBOS = [];
for (const shape of Object.keys(SIM_SHAPE))
  for (const rangeVolMult of [2, 3, 4])
    for (const stopLossPct of [-10, null])
      for (const outOfRangeWaitMinutes of [240, 720])
        COMBOS.push({ id: `${shape}|${rangeVolMult}|${stopLossPct ?? "off"}|${outOfRangeWaitMinutes}`, shape, rangeVolMult, stopLossPct, outOfRangeWaitMinutes });
// The bot's current per-tier params, per shape, to score today's config fairly.
for (const shape of Object.keys(SIM_SHAPE)) COMBOS.push({ id: `current|${shape}`, shape, current: true });

// ─── Data ────────────────────────────────────────────────────────────────────
const wanted = flags.symbols ? new Set(flags.symbols.split(",").map(x => x.trim())) : null;
const universe = (await buildUniverse({ maxPools: Number(flags["max-pools"]) })).filter(u => !wanted || wanted.has(u.symbol));
console.log(`Universe: ${universe.length} pools — ${universe.map(u => u.symbol).join(", ")}`);
const endSec = hourNowSec();
const rows = [];
for (const u of universe) {
  const { candles, lpFees } = await loadHistory(u.pool.address, { days, endSec, refresh: flags.refresh });
  const t = config.screening.tiers[u.tier];
  for (let i = 72; i + horizon < candles.length; i += step) {
    const raw = classifyRegime(candles, i);
    if (!raw) continue;
    const fee24 = lpFees.slice(i - 23, i + 1).reduce((a, b) => a + b, 0) / u.pool.tvl * 100;
    if (fee24 < 0.01) continue;
    const returns = {};
    for (const c of COMBOS) {
      const params = {
        rangeVolMult: c.current ? t.rangeVolMult : c.rangeVolMult,
        stopLossPct: c.current ? t.stopLossPct : c.stopLossPct,
        outOfRangeWaitMinutes: c.current ? m.outOfRangeWaitMinutes : c.outOfRangeWaitMinutes,
        takeProfitPct: null, outOfRangeBinsToClose: m.outOfRangeBinsToClose, minFeePerTvl24h: null, minAgeBeforeYieldCheck: m.minAgeBeforeYieldCheck, belowRangeWaitMinutes: null,
      };
      returns[c.id] = simulateEpisode({ candles, lpFees, tvl: u.pool.tvl, binStep: u.pool.pool_config.bin_step, i0: i, strategy: { side: "below", shape: SIM_SHAPE[c.shape] }, vol: raw.vol24, params, costs, concentration: Number(flags.concentration), horizonHours: horizon }).pnlPct;
    }
    rows.push({ mint: u.mint, symbol: u.symbol, ts: candles[i].timestamp, raw, returns });
  }
}
const times = [...new Set(rows.map(r => r.ts))].sort((a, b) => a - b);
const at = q => times[Math.floor(times.length * q)];
const gap = horizon * 3600;
const fit = rows.filter(r => r.ts < at(0.5) - gap);
const validate = rows.filter(r => r.ts >= at(0.5) && r.ts < at(0.7) - gap);
const test = rows.filter(r => r.ts >= at(0.7));
const day = s => new Date(s * 1000).toISOString().slice(0, 10);
console.log(`Episodes: ${rows.length} × ${COMBOS.length} combos | fit ${fit.length} (<${day(at(0.5))}) · validate ${validate.length} · test ${test.length} (≥${day(at(0.7))})`);

// ─── Regime keys under candidate thresholds ─────────────────────────────────
const regimeOf = (raw, th) => {
  const trend = raw.trend72 > th.trendPct && raw.trend24 > 0 ? "up" : raw.trend72 < -th.trendPct && raw.trend24 < 0 ? "down" : "range";
  return `${trend}/${raw.vol24 < th.lowVol ? "low" : raw.vol24 > th.highVol ? "high" : "mid"}`;
};
const withFeatures = (set, th, extra = () => ({})) => set.map(r => ({ ...r, features: { regime: regimeOf(r.raw, th), ...extra(r) } }));
const tunable = rs => rs.map(r => ({ ...r, returns: Object.fromEntries(Object.entries(r.returns).filter(([id]) => !id.startsWith("current|"))) }));
const LEVELS = [["regime"], []];

const thresholdSets = [];
for (const trendPct of [3, 5, 8, 12])
  for (const lowVol of [3, 5])
    for (const highVol of [10, 15, 20]) thresholdSets.push({ trendPct, lowVol, highVol });

function tune(minEdgePct) {
  let best = null;
  for (const th of thresholdSets) {
    const policy = learnPolicy(tunable(withFeatures(fit, th)), { levels: LEVELS, minSamples: 8, minEdgePct });
    const score = evaluate(withFeatures(validate, th), r => choose(policy, r.features));
    if (!best || score.mean > best.score.mean) best = { th, score };
  }
  const policy = learnPolicy(tunable(withFeatures([...fit, ...validate], best.th)), { levels: LEVELS, minSamples: 8, minEdgePct });
  return { ...best, policy, test: evaluate(withFeatures(test, best.th), r => choose(policy, r.features)) };
}

// Baselines on test.
const currentMap = r => { const shape = DEFAULT_REGIME_STRATEGIES[regimeOf(r.raw, REGIME_DEFAULTS)] ?? config.strategy.regimeFallback; return shape === "skip" ? SKIP : `current|${shape}`; };
const report = [
  ["hold SOL (skip all)", evaluate(test, () => SKIP)],
  ["bot before auto (spot, tier params)", evaluate(test, () => "current|spot")],
  ["bot now (auto default map, tier params)", evaluate(test, currentMap)],
  ["calm label entry (bid_ask ×4, stop -10, OOR 240)", evaluate(test, () => "bid_ask|4|-10|240")],
];
const strict = tune(0), trading = tune(skipBelow);
report.push([`tuned, only positive regimes`, strict.test], [`tuned, skip below ${skipBelow}%/ep`, trading.test]);
report.push(["oracle (upper bound)", evaluate(test, r => { const b = Object.entries(r.returns).sort((a, b) => b[1] - a[1])[0]; return b[1] > 0 ? b[0] : SKIP; })]);

console.log(`\n${"Test period".padEnd(44)} ${"mean/ep".padStart(8)} ${"traded".padStart(7)} ${"win%".padStart(6)} ${"if traded".padStart(10)}`);
for (const [name, r] of report) console.log(`${name.padEnd(44)} ${fmt(r.mean).padStart(8)} ${String(r.traded).padStart(7)} ${r.winRate.toFixed(0).padStart(6)} ${fmt(r.tradedMean).padStart(10)}`);

const toConfig = (policy) => Object.fromEntries(Object.entries(policy.table).filter(([k]) => k !== "*").map(([k, v]) => {
  const regime = k.replace("regime=", "");
  if (v.pick === SKIP) return [regime, "skip"];
  const [shape, rangeVolMult, stop, oor] = v.pick.split("|");
  return [regime, { shape, rangeVolMult: Number(rangeVolMult), stopLossPct: stop === "off" ? null : Number(stop), outOfRangeWaitMinutes: Number(oor), fitMeanPct: Number(v.mean.toFixed(3)), n: v.n }];
}));
for (const [label, t] of [["only positive regimes", strict], [`skip below ${skipBelow}%`, trading]]) {
  console.log(`\nTuned (${label}): thresholds ${JSON.stringify(t.th)} — validate ${fmt(t.score.mean)} → test ${fmt(t.test.mean)}`);
  for (const [k, v] of Object.entries(toConfig(t.policy)).sort()) console.log(`  ${k.padEnd(11)} → ${typeof v === "string" ? v : `${v.shape} range×${v.rangeVolMult} stop ${v.stopLossPct ?? "off"} OOR ${v.outOfRangeWaitMinutes}m (fit ${fmt(v.fitMeanPct)}%, n ${v.n})`}`);
}

// ─── Jev: which text features help, and does an "established" gate help? ─────
const jevReport = {};
if (!flags["no-jev"] && process.env.TYPESAFE_API_KEY) {
  const answers = await jevFeatures(universe, JEV_QUESTIONS);
  const yes = (mint, q) => (answers[mint]?.[q]?.noul ?? 0) >= 0.5 ? "yes" : "no";
  console.log(`\nJev answers (≥0.5 = yes): ${universe.map(u => `${u.symbol}:${Object.keys(JEV_QUESTIONS).filter(q => yes(u.mint, q) === "yes").join("+") || "-"}`).join("  ")}`);
  const th = trading.th;
  const base = learnPolicy(tunable(withFeatures(fit, th)), { levels: LEVELS, minSamples: 8, minEdgePct: skipBelow });
  const baseVal = evaluate(withFeatures(validate, th), r => choose(base, r.features)).mean;
  const scored = Object.keys(JEV_QUESTIONS).map(q => {
    const extra = r => ({ [q]: yes(r.mint, q) });
    const policy = learnPolicy(tunable(withFeatures(fit, th, extra)), { levels: [["regime", q], ...LEVELS], minSamples: 8, minEdgePct: skipBelow });
    return { q, validate: evaluate(withFeatures(validate, th, extra), r => choose(policy, r.features)).mean, extra };
  }).sort((a, b) => b.validate - a.validate);
  console.log(`Jev feature on top of tuned regimes — validate mean/ep (no Jev: ${fmt(baseVal)}):`);
  for (const s of scored) console.log(`  ${s.q.padEnd(11)} ${fmt(s.validate)}`);
  const pick = scored[0];
  if (pick.validate > baseVal) {
    const policy = learnPolicy(tunable(withFeatures([...fit, ...validate], th, pick.extra)), { levels: [["regime", pick.q], ...LEVELS], minSamples: 8, minEdgePct: skipBelow });
    const t = evaluate(withFeatures(test, th, pick.extra), r => choose(policy, r.features));
    console.log(`  → best on validate: "${pick.q}"; test ${fmt(t.mean)} vs tuned without Jev ${fmt(trading.test.mean)}`);
    jevReport.feature = { question: pick.q, validate: pick.validate, test: t.mean, withoutJevTest: trading.test.mean };
  } else console.log("  → no Jev feature beats the regime-only policy on validate");
  // Gate: only trade tokens Jev rates as established ≥ g.
  const gates = [0, 0.3, 0.5, 0.7, 0.9].map(g => {
    const gated = (set, policy) => evaluate(withFeatures(set, th), r => (answers[r.mint]?.established?.noul ?? 0) >= g ? choose(policy, r.features) : SKIP);
    const policy = learnPolicy(tunable(withFeatures(fit, th)).filter(r => (answers[r.mint]?.established?.noul ?? 0) >= g), { levels: LEVELS, minSamples: 8, minEdgePct: skipBelow });
    return { g, validate: gated(validate, policy).mean, policy, gated };
  }).sort((a, b) => b.validate - a.validate);
  const g = gates[0];
  const refit = learnPolicy(tunable(withFeatures([...fit, ...validate], th)).filter(r => (answers[r.mint]?.established?.noul ?? 0) >= g.g), { levels: LEVELS, minSamples: 8, minEdgePct: skipBelow });
  console.log(`minEstablished gate — validate: ${gates.map(x => `${x.g}:${fmt(x.validate)}`).join("  ")} → best ${g.g}, test ${fmt(g.gated(test, refit).mean)}`);
  jevReport.minEstablished = { best: g.g, test: g.gated(test, refit).mean, validate: Object.fromEntries(gates.map(x => [x.g, x.validate])) };
} else console.log("\nJev: skipped (no TYPESAFE_API_KEY or --no-jev)");

fs.writeFileSync(path.join(cacheDir, "tuned.json"), JSON.stringify({
  generatedAt: new Date().toISOString(), days, horizon, step, costs,
  test: Object.fromEntries(report),
  strict: { thresholds: strict.th, regimeStrategies: toConfig(strict.policy) },
  trading: { thresholds: trading.th, regimeStrategies: toConfig(trading.policy) },
  jev: jevReport,
}, null, 2));
console.log(`\nCaveats: today's pools only (survivorship); TVL fixed; overlapping episodes; fee share × ${flags.concentration}. Saved .backtest-cache/tuned.json`);
