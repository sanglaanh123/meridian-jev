/**
 * Unit tests for the scanner → tiered screening → entry → exit pipeline
 * (no network, no wallet, no writes outside temp dirs).
 * Run: node test/test-standalone.js
 */

import "./setup-env.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { config, validateConfig } from "../config.js";
import { MonitorStore, acceptPoolSignal, signalBlocked, finishSignal, finishStaleSignals } from "../standalone/store.js";
import { aggregateTokenAccounts } from "../standalone/balances.js";
import { INDICATOR_GATES } from "../standalone/indicators.js";
import { escapeHtml } from "../telegram.js";
import { tierFor, tierLimits, rejectToken, rejectPool } from "../standalone/screening.js";
import { realizedVolatility } from "../standalone/meteora.js";
import { listFilter, preselect, interleaveTiers, scanOnce } from "../standalone/scanner.js";
import { withWalletLock } from "../standalone/transactions.js";
import { getDeterministicCloseRule, computeBinsBelow } from "../exit-rules.js";
import { closeDb, getKv, readOnlyQuery } from "../db.js";
import { trackPosition, recordClose, getTrackedPositions, getStateSummary, syncOpenPositions } from "../state.js";
import { recordPerformance, getPerformanceBreakdown, getPerformanceHistory } from "../performance.js";
import { recordPoolDeploy, isPoolOnCooldown, isBaseMintOnCooldown, getPoolMemory } from "../pool-memory.js";
import { isBlacklisted, addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { appendDecision, getRecentDecisions } from "../decision-log.js";

const options = { screeningDeadlineSec: 120, cooldownSec: 3600 };

let failed = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const MINT = "Mint111111111111111111111111111111111111111";
const POOL_A = "Po01AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const S = config.screening;
const BLUE = S.tiers.bluechip, MID = S.tiers.midcap;
// Each call points db.js at a fresh SQLite file in its own temp dir; returns that dir.
const useTempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mer-"));
  closeDb();
  process.env.MERIDIAN_DB = path.join(dir, "meridian.db");
  return dir;
};
const tempStore = () => { useTempDb(); return new MonitorStore(); };

// JUP-like bluechip token and its SOL pool; override per case.
const token = (o = {}, now = Date.now()) => ({
  id: MINT, isVerified: true, tags: ["strict", "verified", "defi"], mcap: 900_000_000,
  holderCount: 800_000, organicScore: 96, createdAt: new Date(now - 700 * 86_400_000).toISOString(),
  updatedAt: new Date(now - 10_000).toISOString(),
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15 },
  ...o,
});
const pool = (o = {}, now = Date.now()) => ({
  address: POOL_A, name: "JUP-SOL", is_blacklisted: false,
  token_x: { address: MINT, market_cap: 900_000_000 }, token_y: { address: config.tokens.SOL },
  tvl: 2_000_000, volume: { "24h": 500_000 }, pool_config: { bin_step: 80 },
  fee_tvl_ratio: { "4h": 0.01, "24h": 0.04 }, created_at: now - 30 * 86_400_000,
  current_price: 0.0027, daily_vol_pct: 3,
  ...o,
});

// ─── Tiers ───────────────────────────────────────────────────────────────────
console.log("\n[1] tierFor / tierLimits / validateConfig");
{
  check("600M is bluechip", tierFor(600e6) === "bluechip");
  check("80M is midcap", tierFor(80e6) === "midcap");
  check("500M boundary belongs to bluechip", tierFor(500e6) === "bluechip");
  check("10M is below every tier", tierFor(10e6) === null);
  check("unknown mcap has no tier", tierFor(null) === null && tierFor("abc") === null);
  check("disabled tier is skipped", tierFor(600e6, { ...S, enabledTiers: ["midcap"] }) === null && tierFor(80e6, { ...S, enabledTiers: ["bluechip"] }) === null);
  const caps = { tiers: { midcap: { maxPositions: 2 } } }; // explicit: user-config may change the cap
  check("tier cap not reached", !tierLimits({ midcap: 1 }, "midcap", caps).full);
  check("tier cap reached", tierLimits({ midcap: 2 }, "midcap", caps).full);
  check("unknown tier is always full", tierLimits({}, "nope").full);
  const saved = config.jev.mode;
  config.jev.mode = "on";
  check("invalid jevMode is reported", validateConfig().some(p => p.includes("jevMode")));
  config.jev.mode = "shadow";
  check("valid config validates", validateConfig().length === 0, validateConfig().join("; "));
  config.jev.mode = saved;
}

// ─── Screening gates ─────────────────────────────────────────────────────────
console.log("\n[2] rejectToken — tier token rules, missing data never passes");
{
  const now = Date.now();
  check("JUP-like bluechip passes", rejectToken(token({}, now), MINT, BLUE, S, now) === null, rejectToken(token({}, now), MINT, BLUE, S, now));
  check("mint mismatch rejected", rejectToken(token({}, now), POOL_A, BLUE, S, now) !== null);
  check("stale data rejected", rejectToken(token({ updatedAt: new Date(now - 300_000).toISOString() }, now), MINT, BLUE, S, now) !== null);
  check("unverified rejected", rejectToken(token({ isVerified: false }, now), MINT, BLUE, S, now) !== null);
  check("missing required tag rejected", rejectToken(token({ tags: ["community"] }, now), MINT, BLUE, S, now) !== null);
  check("verified tag is enough for midcap", rejectToken(token({ tags: ["verified"], mcap: 80e6, holderCount: 20_000 }, now), MINT, MID, S, now) === null);
  check("mcap outside tier band rejected", rejectToken(token({ mcap: 80e6 }, now), MINT, BLUE, S, now) !== null);
  check("young token rejected", rejectToken(token({ createdAt: new Date(now - 5 * 86_400_000).toISOString() }, now), MINT, BLUE, S, now) !== null);
  check("midcap with 3k holders rejected", rejectToken(token({ tags: ["verified"], mcap: 80e6, holderCount: 3_000 }, now), MINT, MID, S, now) !== null);
  check("low organic score rejected", rejectToken(token({ organicScore: 20 }, now), MINT, BLUE, S, now) !== null);
  check("unknown top-holder share rejected", rejectToken(token({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }, now), MINT, BLUE, S, now) !== null);
  const auth = token({ audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true, topHoldersPercentage: 15 } }, now);
  check("enabled authority rejected when renounce is required", rejectToken(auth, MINT, BLUE, S, now) !== null);
  check("enabled authority allowed when renounce is relaxed", rejectToken(auth, MINT, BLUE, { ...S, requireRenouncedAuthorities: false }, now) === null);
}

console.log("\n[3] rejectPool — tier pool rules, fee stability, volatility");
{
  const now = Date.now();
  const r = (o, t = BLUE, opts = {}) => rejectPool(pool(o, now), MINT, t, S, { now, ...opts });
  check("healthy bluechip pool passes", r({}) === null, r({}));
  check("wrong quote side rejected", r({ token_y: { address: "USDC" } }) !== null);
  check("blacklisted rejected", r({ is_blacklisted: true }) !== null);
  check("low TVL rejected", r({ tvl: 50_000 }) !== null);
  check("bin step above tier band rejected", r({ pool_config: { bin_step: 150 } }) !== null);
  check("same bin step passes the wider midcap band", r({ pool_config: { bin_step: 150 }, fee_tvl_ratio: { "4h": 0.05, "24h": 0.2 } }, MID) === null);
  check("low 24h fee/TVL rejected", r({ fee_tvl_ratio: { "4h": 0.003, "24h": 0.01 } }) !== null);
  check("fee spike fails stability", r({ fee_tvl_ratio: { "4h": 0.05, "24h": 0.06 } }) !== null);
  check("fees dried up fail stability", r({ fee_tvl_ratio: { "4h": 0.0005, "24h": 0.04 } }) !== null);
  check("new pool rejected", r({ created_at: now - 3_600_000 }) !== null);
  check("high volatility rejected", r({ daily_vol_pct: 30 }) !== null);
  check("missing volatility rejected", r({ daily_vol_pct: null }) !== null);
  check("volatility skipped for list pre-filter", r({ daily_vol_pct: undefined }, BLUE, { volatility: false }) === null);
  check("missing fields rejected", r({ volume: {} }) !== null && r({ pool_config: undefined }) !== null);
}

console.log("\n[4] realizedVolatility — hourly closes to daily %");
{
  check("empty series is unknown", realizedVolatility([]) === null && realizedVolatility(null) === null);
  check("fewer than 12 candles is unknown", realizedVolatility(Array.from({ length: 11 }, () => ({ close: 1 }))) === null);
  const step = 0.01;
  const closes = Array.from({ length: 13 }, (_, i) => ({ close: i % 2 ? 100 * (1 + step) : 100 }));
  const r = Math.log(1 + step);
  const expected = r * Math.sqrt(12 / 11) * Math.sqrt(24) * 100;
  check("alternating ±1% series matches the formula", Math.abs(realizedVolatility(closes) - expected) < 1e-9, `${realizedVolatility(closes)} vs ${expected}`);
  check("flat series is zero (and rejected downstream)", realizedVolatility(Array.from({ length: 24 }, () => ({ close: 5 }))) === 0);
}

// ─── Balances ────────────────────────────────────────────────────────────────
console.log("\n[5] aggregateTokenAccounts — SPL + Token-2022, no phantom zeros");
{
  const acct = (mint, amount, decimals) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } } });
  const tokens = aggregateTokenAccounts([
    { value: [acct(MINT, 1000, 6), acct(config.tokens.USDC, 0, 6)] },
    { value: [acct(MINT, 2500, 6)] },
  ]);
  check("same mint aggregated across programs", tokens.length === 1 && tokens[0].balance === 0.0035 && tokens[0].mint === MINT);
  check("zero-balance accounts dropped", !tokens.some(t => t.mint === config.tokens.USDC));
  let conflicted = false;
  try { aggregateTokenAccounts([{ value: [acct(MINT, 1, 6)] }, { value: [acct(MINT, 1, 9)] }]); } catch { conflicted = true; }
  check("conflicting decimals rejected", conflicted);
}

// ─── Range sizing ────────────────────────────────────────────────────────────
console.log("\n[6] computeBinsBelow — volatility × bin step, 35-bin floor");
{
  const lo = config.strategy.minBinsBelow, hi = config.strategy.maxBinsBelow;
  check("calm bluechip at bin step 80 hits the floor", computeBinsBelow(3, 80, 2) === lo);
  const expected = Math.ceil(-Math.log(1 - 0.10) / Math.log(1.002));
  check("10% target at bin step 20 matches the formula", computeBinsBelow(5, 20, 2) === Math.min(hi, Math.max(lo, expected)), String(computeBinsBelow(5, 20, 2)));
  check("tiny bin step clamps to the max", computeBinsBelow(1, 1, 2) === hi);
  check("wider multiplier never shrinks the range", computeBinsBelow(5, 20, 2.5) >= computeBinsBelow(5, 20, 2));
  for (const [args, label] of [[[null, 80], "unknown volatility"], [[3, 0], "zero bin step"], [[3, 80, -1], "negative multiplier"]]) {
    let threw = false;
    try { computeBinsBelow(...args); } catch { threw = true; }
    check(`${label} refuses to deploy`, threw);
  }
}

// ─── Coordination + rules ────────────────────────────────────────────────────
console.log("\n[7] withWalletLock — exits jump the queue, never concurrent");
{
  const order = [];
  const job = (label, ms) => async () => { order.push(`start:${label}`); await new Promise(r => setTimeout(r, ms)); order.push(`end:${label}`); };
  const first = withWalletLock(job("deploy", 40), 0);
  const second = withWalletLock(job("close", 1), 10);
  const third = withWalletLock(job("claim", 1), 5);
  await Promise.all([first, second, third]);
  check("serialized execution", order[0] === "start:deploy" && order[1] === "end:deploy");
  check("exit priority runs before other writes", order[2] === "start:close" && order[4] === "start:claim");
}

console.log("\n[8] deterministic exit rules");
{
  const pos = base => ({ position: "Pos111111111111111111111111111111111111111", pair: "T/SOL", pnl_pct: 0, active_bin: 100, upper_bin: 100, minutes_out_of_range: 0, age_minutes: 90, fee_per_tvl_24h: 10, ...base });
  // Explicit values: the local user-config.json may still carry older overrides.
  const mgmt = { ...config.management, stopLossPct: -15, takeProfitPct: null, outOfRangeBinsToClose: 30 };
  check("global stop loss closes untracked positions", getDeterministicCloseRule(pos({ pnl_pct: -20 }), mgmt)?.rule === 1);
  check("drawdown above the stop holds", getDeterministicCloseRule(pos({ pnl_pct: -12 }), mgmt) === null);
  check("take profit null is off", getDeterministicCloseRule(pos({ pnl_pct: 80 }), mgmt) === null);
  check("take profit fires when configured", getDeterministicCloseRule(pos({ pnl_pct: 10 }), { ...mgmt, takeProfitPct: 5 })?.rule === 2);
  check("pumped far above range closes", getDeterministicCloseRule(pos({ active_bin: 100 + mgmt.outOfRangeBinsToClose + 1 }), mgmt)?.rule === 3);
  check("suspect PnL never closes on PnL rules", getDeterministicCloseRule(pos({ pnl_pct: -95, pnl_pct_suspicious: true }), mgmt) === null);
}

// ─── Signals + store ─────────────────────────────────────────────────────────
console.log("\n[9] acceptPoolSignal / finishSignal / finishStaleSignals / store migration");
{
  const store = tempStore();
  const now = Date.now();
  const cand = { mint: MINT, pool: POOL_A, tier: "bluechip", reasons: ["bluechip"], metrics: { tvl: 1 } };
  const s1 = acceptPoolSignal(store, cand, options, now);
  check("scanner candidate becomes a meteora signal", s1?.source === "meteora" && s1.pool === POOL_A && s1.tier === "bluechip" && s1.deadline === now + options.screeningDeadlineSec * 1000);
  check("no duplicate while the signal is open", acceptPoolSignal(store, cand, options, now + 1000) === null && signalBlocked(store, MINT, now + 1000));
  finishSignal(store, s1, "test done", options, now + 2000);
  check("finished signal blocks during cooldown", acceptPoolSignal(store, cand, options, now + 3000) === null);
  const after = now + 2000 + options.cooldownSec * 1000 + 1;
  check("mint can signal again after the cooldown", acceptPoolSignal(store, cand, options, after)?.createdAt === after);
  let threw = false;
  try { finishSignal(store, store.data.signals[MINT], "x"); } catch { threw = true; }
  check("finishSignal without options throws (regression guard for call sites)", threw);

  const stale = tempStore();
  stale.data.signals.stuck = { mint: "stuck", createdAt: now - 9e5, deadline: now - 8e5, done: false };
  stale.data.signals.fine = { mint: "fine", createdAt: now - 9e5, done: true, reason: "entered", closedAt: now - 8e5, cooldownUntil: now - 5e5 };
  const before = JSON.stringify(stale.data.signals.fine);
  const n = finishStaleSignals(stale, options, now);
  check("stale signal cleared with a cooldown", n === 1 && stale.data.signals.stuck.done && stale.data.signals.stuck.cooldownUntil === now + options.cooldownSec * 1000);
  check("done signals unchanged", JSON.stringify(stale.data.signals.fine) === before);

  const dir = useTempDb();
  const legacy = path.join(dir, "wallet-monitor-state.json");
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, wallets: { W: {} }, pending: { k: {} }, seen: { k: 1 }, events: [{ id: 1 }], signals: {}, attempts: { [MINT]: { at: now, status: "entered" } }, paused: false }));
  const migrated = new MonitorStore();
  const extras = getKv("monitor_extras");
  check("legacy JSON imported: attempts kept, retired keys dropped, extras kept", migrated.data.attempts[MINT]?.status === "entered" && !("wallets" in migrated.data) && !("events" in extras) && extras.paused === false);
  check("imported JSON renamed to .migrated", !fs.existsSync(legacy) && fs.existsSync(`${legacy}.migrated`));
  migrated.save();
  closeDb();
  check("store round-trips through SQLite", new MonitorStore().data.attempts[MINT]?.status === "entered");

  migrated.data.attempts[MINT] = { at: now - 25 * 3600_000, status: "failed" };
  migrated.data.attempts.Other = { at: now - 25 * 3600_000, status: "submitting" };
  migrated.prune(now);
  check("attempts pruned after 24h except mid-submit", migrated.data.attempts[MINT] === undefined && migrated.data.attempts.Other);

  const badDir = useTempDb();
  const bad = path.join(badDir, "wallet-monitor-state.json");
  fs.writeFileSync(bad, JSON.stringify({ version: 99 }));
  let refused = false;
  try { new MonitorStore(); } catch { refused = true; }
  check("invalid state refused, not discarded", refused && fs.existsSync(bad));
}

// ─── SQLite stores ───────────────────────────────────────────────────────────
console.log("\n[9b] SQLite stores — positions, performance, pool memory, blacklist, decisions, read-only query");
{
  useTempDb();
  trackPosition({ position: "PosA", pool: POOL_A, pool_name: "TEST-SOL", strategy: "spot", amount_sol: 0.5, tier: "bluechip", label: "calm" });
  trackPosition({ position: "PosB", pool: POOL_A, pool_name: "TEST-SOL", strategy: "spot", amount_sol: 0.5 });
  check("tracked positions are open", getTrackedPositions(true).length === 2);
  recordClose("PosA", "stop loss");
  const summary = getStateSummary();
  check("close recorded with events", summary.open_positions === 1 && summary.closed_positions === 1 && summary.recent_events.map(e => e.action).join() === "deploy,deploy,close");
  syncOpenPositions([]);
  check("sync keeps positions inside the grace period", getTrackedPositions(true).length === 1);

  const perf = { position: "PosA", pool: POOL_A, pool_name: "TEST-SOL", base_mint: MINT, tier: "bluechip", label: "calm", strategy: "spot", amount_sol: 0.5, initial_value_usd: 100, final_value_usd: 95, fees_earned_usd: 1, minutes_held: 60, minutes_in_range: 30, close_reason: "out of range" };
  await recordPerformance(perf);
  await recordPerformance({ ...perf, position: "PosC", final_value_usd: 110, close_reason: "take profit" });
  const breakdown = getPerformanceBreakdown({ hours: 24 });
  check("performance breakdown totals", breakdown.count === 2 && breakdown.total_pnl_usd === 7 && breakdown.win_rate_pct === 50, JSON.stringify(breakdown));
  check("breakdown grouped by tier and reason", breakdown.by_tier[0]?.key === "bluechip" && breakdown.by_close_reason.length === 2);
  check("performance history window", getPerformanceHistory({ hours: 24 }).count === 2);
  check("pool memory written from performance", getPoolMemory({ pool_address: POOL_A }).total_deploys === 2);

  recordPoolDeploy("PoolSibling", { pool_name: "SIB-SOL", base_mint: MINT, pnl_pct: 1, close_reason: "take profit" });
  for (let i = 0; i < 3; i++) recordPoolDeploy(POOL_A, { base_mint: MINT, pnl_pct: -1, close_reason: "out of range" });
  check("repeated OOR closes cool the pool", isPoolOnCooldown(POOL_A));
  check("base-mint cooldown reaches sibling pools", isBaseMintOnCooldown(MINT) && getPoolMemory({ pool_address: "PoolSibling" }).base_mint_cooldown_until != null);

  addToBlacklist({ mint: "BadMint", symbol: "BAD", reason: "rug" });
  check("blacklist add", isBlacklisted("BadMint") && listBlacklist().count === 1 && addToBlacklist({ mint: "BadMint" }).already_blacklisted);
  removeFromBlacklist({ mint: "BadMint" });
  check("blacklist remove", !isBlacklisted("BadMint") && listBlacklist().count === 0);

  appendDecision({ type: "deploy", summary: "first" });
  appendDecision({ type: "close", summary: "second" });
  check("decisions newest first", getRecentDecisions(2).map(d => d.summary).join() === "second,first");

  check("read-only query returns rows", readOnlyQuery("SELECT COUNT(*) AS n FROM positions")[0]?.n === 2);
  let blocked = 0;
  for (const sql of ["DELETE FROM positions", "WITH x AS (SELECT 1) DELETE FROM positions"]) {
    try { readOnlyQuery(sql); } catch { blocked++; }
  }
  check("read-only query rejects writes", blocked === 2 && readOnlyQuery("SELECT COUNT(*) AS n FROM positions")[0]?.n === 2);
}

// ─── Scanner ─────────────────────────────────────────────────────────────────
console.log("\n[10] scanner — list filter, pre-filter, tier interleave, scanOnce");
const realFetch = globalThis.fetch;
const savedRpc = config.standalone.rpcUrl;
const savedJev = { ...config.jev };
const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const rpcStub = async (opts, TOKEN_PROGRAMS) => {
  const req = JSON.parse(opts.body);
  return json({ jsonrpc: "2.0", id: req.id, result: { context: { slot: 1 }, value: { data: { program: "spl-token", space: 82, parsed: { info: { mintAuthority: null, freezeAuthority: null } } }, owner: TOKEN_PROGRAMS[0], lamports: 1, executable: false, rentEpoch: 0 } } });
};
{
  const { TOKEN_PROGRAMS } = await import("../standalone/balances.js");
  const f = listFilter();
  check("list filter covers the lowest tier floors", f.includes(`tvl>=${Math.min(BLUE.minTvl, MID.minTvl)}`) && f.includes(`token_y=${config.tokens.SOL}`) && f.includes("is_blacklisted=false"));

  const now = Date.now();
  const mid = (mint, fee) => pool({ address: `Pool${mint}`, token_x: { address: mint, market_cap: 80e6 }, fee_tvl_ratio: { "4h": fee / 6, "24h": fee } }, now);
  const listed = [
    mid("MidA", 1.0), mid("MidB", 0.8), mid("MidC", 0.6),
    pool({ address: "PoolBlue", token_x: { address: "Blue", market_cap: 9e8 } }, now),
    pool({ address: "PoolMeme", token_x: { address: "Meme", market_cap: 5e6 }, fee_tvl_ratio: { "4h": 1, "24h": 5 } }, now),
    mid("MidA", 0.5), // second pool for MidA: the first (better) one wins
  ];
  const pre = preselect(listed, { now });
  check("memes below the midcap floor are dropped", !pre.some(c => c.mint === "Meme"));
  check("one candidate per mint, best pool first", pre.filter(c => c.mint === "MidA").length === 1 && pre.find(c => c.mint === "MidA").pool === "PoolMidA");
  check("skipMint excludes held mints", !preselect(listed, { now, skipMint: m => m === "MidB" }).some(c => c.mint === "MidB"));
  const order = interleaveTiers(pre).map(c => c.mint);
  check("tiers interleave so a bluechip is screened early", order.indexOf("Blue") === 1, order.join(","));

  // scanOnce end-to-end with stubbed Meteora, Jupiter and RPC.
  config.standalone.rpcUrl = "http://127.0.0.1:1/rpc";
  config.jev.mode = "off";
  const BLUE_MINT = Keypair.generate().publicKey.toBase58();
  let listFails = false;
  let tokenOverride = {};
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("dlmm.datapi.meteora.ag/pools?")) {
      if (listFails) return { ok: false, status: 500, json: async () => ({}) };
      return json({ data: [pool({ address: "PoolBlueLive", token_x: { address: BLUE_MINT, market_cap: 9e8 } })] });
    }
    if (u.includes("/ohlcv")) return json({ data: Array.from({ length: 25 }, (_, i) => ({ close: 1 + (i % 2) * 0.002 })) });
    if (u.includes("dlmm.datapi.meteora.ag/pools/PoolBlueLive")) return json(pool({ address: "PoolBlueLive", token_x: { address: BLUE_MINT, market_cap: 9e8 } }));
    if (u.includes("datapi.jup.ag")) return json([token({ id: BLUE_MINT, ...tokenOverride })]);
    if (u.includes("/rpc")) return rpcStub(opts, TOKEN_PROGRAMS);
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const noPositions = async () => ({ positions: [] });
    const store = tempStore();
    const signals = [];
    let report = await scanOnce({ store, onSignal: s => signals.push(s), options, readPositions: noPositions });
    check("passing bluechip emits one signal", report.emitted.length === 1 && signals[0]?.mint === BLUE_MINT && signals[0].tier === "bluechip", JSON.stringify(report.candidates));
    report = await scanOnce({ store, onSignal: s => signals.push(s), options, readPositions: noPositions });
    check("open signal is not re-emitted", report.emitted.length === 0 && signals.length === 1);

    const fresh = tempStore();
    report = await scanOnce({ store: fresh, options, readPositions: async () => ({ positions: [{ base_mint: BLUE_MINT }] }) });
    check("held mint is skipped", report.candidates.length === 0);

    report = await scanOnce({ store: fresh, options, readPositions: async () => ({ error: "down" }) });
    check("unreadable portfolio skips the scan", report.error && report.candidates.length === 0);

    const preview = tempStore();
    report = await scanOnce({ store: preview, emit: false, options, readPositions: noPositions });
    check("preview screens without storing", report.candidates.length === 1 && report.candidates[0].pass && Object.keys(preview.data.signals).length === 0);

    // A token-rule failure on fresh data parks the mint so later scans reach other mints.
    tokenOverride = { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 95 } };
    const parked = tempStore();
    report = await scanOnce({ store: parked, options, readPositions: noPositions });
    check("token-rule reject is parked for the cooldown", /topHoldersPercentage/.test(report.candidates[0]?.reason ?? "") && parked.data.signals[BLUE_MINT]?.done === true && signalBlocked(parked, BLUE_MINT), JSON.stringify(report.candidates));
    report = await scanOnce({ store: parked, options, readPositions: noPositions });
    check("parked mint is not re-screened next scan", report.candidates.length === 0);
    tokenOverride = { updatedAt: new Date(Date.now() - 3_600_000).toISOString() };
    const stale = tempStore();
    report = await scanOnce({ store: stale, options, readPositions: noPositions });
    check("stale token data is retried, not parked", /stale/.test(report.candidates[0]?.reason ?? "") && !stale.data.signals[BLUE_MINT]);
    tokenOverride = {};

    listFails = true;
    report = await scanOnce({ store: tempStore(), options, readPositions: noPositions });
    check("HTTP 500 skips the scan without throwing", /HTTP 500/.test(report.error ?? ""), report.error);
  } finally {
    globalThis.fetch = realFetch;
    config.standalone.rpcUrl = savedRpc;
    Object.assign(config.jev, savedJev);
  }
}

// ─── Jev ─────────────────────────────────────────────────────────────────────
console.log("\n[11] Jev bluechip classifier");
{
  const { decideEntry, judgeToken } = await import("../standalone/judgment.js");
  const { screenMint } = await import("../standalone/screening.js");
  const { TOKEN_PROGRAMS } = await import("../standalone/balances.js");
  const cfg = { riskMax: 0.7, minEstablished: 0.7, minConfidence: 0.6 };
  const allowed = BLUE.allowedCategories;
  const ans = o => ({ established: { noul: 0.95 }, impersonation: { noul: 0.05 }, category: { choice: "major_defi", confidence: 0.9 }, ...o });
  check("established project approves", decideEntry(ans(), allowed, cfg).decision === "approve");
  check("impersonation rejects", decideEntry(ans({ impersonation: { noul: 0.9 } }), allowed, cfg).decision === "reject");
  check("disallowed confident category rejects", decideEntry(ans({ category: { choice: "other", confidence: 0.9 } }), allowed, cfg).decision === "reject");
  check("disallowed but unsure category does not reject", decideEntry(ans({ category: { choice: "other", confidence: 0.3 } }), allowed, cfg).decision === "approve");
  check("obscure token is uncertain", decideEntry(ans({ established: { noul: 0.2 } }), allowed, cfg).decision === "uncertain");
  check("missing answers are uncertain", decideEntry({}, allowed, cfg).decision === "uncertain");

  const saved = { jev: { ...config.jev }, rpc: config.standalone.rpcUrl, key: process.env.TYPESAFE_API_KEY };
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  config.standalone.rpcUrl = "http://127.0.0.1:1/rpc";
  let jevCalls = 0, jevBody = null, jevHeaders = null, jevAnswers = ans(), jevFail = false;
  const stub = mint => async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.typesafe.ai")) {
      jevCalls++; jevBody = JSON.parse(opts.body); jevHeaders = opts.headers;
      if (jevFail) return { ok: false, status: 529, json: async () => ({}) };
      return json({ answers: jevAnswers });
    }
    if (u.includes("datapi.jup.ag")) return json([token({ id: mint, name: "Jupiter", symbol: "JUP", website: "https://jup.ag", twitter: "https://x.com/JupiterExchange", dev: "DevX" })]);
    if (u.includes("/ohlcv")) return json({ data: Array.from({ length: 25 }, (_, i) => ({ close: 1 + (i % 2) * 0.002 })) });
    if (u.includes(`dlmm.datapi.meteora.ag/pools/${POOL_A}`)) return json(pool({ token_x: { address: mint, market_cap: 9e8 } }));
    if (u.includes("dlmm.datapi.meteora.ag")) return json({ data: [pool({ token_x: { address: mint, market_cap: 9e8 } })] });
    if (u.includes("/rpc")) return rpcStub(opts, TOKEN_PROGRAMS);
    throw new Error(`unexpected fetch ${u}`);
  };
  const newMint = () => Keypair.generate().publicKey.toBase58();
  try {
    let mint = newMint();
    globalThis.fetch = stub(mint);
    config.jev.mode = "off";
    let r = await screenMint(mint);
    check("off mode makes zero Jev calls", jevCalls === 0 && !r.jev, r.reason);

    config.jev.mode = "approve";
    mint = newMint(); globalThis.fetch = stub(mint);
    r = await screenMint(mint);
    check("approve verdict passes with the verdict attached", jevCalls === 1 && r.pass === true && r.jev?.decision === "approve" && r.tier === "bluechip", r.reason);
    check("request sends bearer key, model and typed questions", jevHeaders?.Authorization === "Bearer test-key-not-real" && jevBody?.model === "jev-latest" && jevBody.questions.established.type === "noul" && Object.keys(jevBody.questions.category.criteria).length === 6);
    check("only identity text is sent", Object.keys(jevBody.state.token).every(k => ["name", "symbol", "verified", "tags", "twitter", "website"].includes(k)) && !JSON.stringify(jevBody).includes("mcap"));
    await screenMint(mint);
    check("cache prevents a second fetch for the same mint", jevCalls === 1);

    jevAnswers = ans({ established: { noul: 0.2 } });
    mint = newMint(); globalThis.fetch = stub(mint);
    r = await screenMint(mint);
    check("approve mode: uncertain is terminal", r.pass === false && r.terminal === true && /Jev uncertain/.test(r.reason), r.reason);

    jevAnswers = ans({ impersonation: { noul: 0.95 } });
    mint = newMint(); globalThis.fetch = stub(mint);
    r = await screenMint(mint);
    check("approve mode: reject is terminal", r.terminal === true && /Jev reject/.test(r.reason), r.reason);

    jevFail = true; mint = newMint(); globalThis.fetch = stub(mint);
    r = await screenMint(mint);
    check("approve mode: Jev error is non-terminal (fail closed)", r.pass === false && !r.terminal && r.reason === "jev unavailable", r.reason);

    config.jev.mode = "veto"; mint = newMint(); globalThis.fetch = stub(mint);
    r = await screenMint(mint);
    check("veto mode: Jev error lets the entry pass", r.pass === true && !r.jev, r.reason);
    jevFail = false; jevAnswers = ans({ impersonation: { noul: 0.95 } });
    mint = newMint(); globalThis.fetch = stub(mint);
    r = await screenMint(mint);
    check("veto mode: reject is terminal", r.terminal === true && /Jev reject/.test(r.reason), r.reason);

    config.jev.mode = "shadow"; mint = newMint(); globalThis.fetch = stub(mint);
    r = await screenMint(mint);
    check("shadow mode never blocks even on a reject verdict", r.pass === true && r.jev?.decision === "reject", r.reason);
    const j = await judgeToken({ id: mint }, allowed);
    check("cached answers re-evaluate per tier categories", j.decision === "reject" && jevCalls > 0);
    // Jev runs last: a closed indicator gate (here: no candles) must not cost a Jev call.
    const gateSaved = config.strategy.unlabeledIndicators;
    config.strategy.unlabeledIndicators = { gate: Object.keys(INDICATOR_GATES).find(g => g !== "none"), exit: "none" };
    config.jev.mode = "approve"; jevFail = false; jevAnswers = ans();
    mint = newMint(); globalThis.fetch = stub(mint);
    const before = jevCalls;
    r = await screenMint(mint);
    config.strategy.unlabeledIndicators = gateSaved;
    check("Jev is not called when the indicator gate rejects", r.pass === false && /indicator/.test(r.reason) && jevCalls === before, r.reason);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.jev, saved.jev);
    config.standalone.rpcUrl = saved.rpc;
    if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.key;
  }
}

console.log("\n[11b] escapeHtml");
check("escapes &, < and >", escapeHtml("A&B <x> ->") === "A&amp;B &lt;x&gt; -&gt;" && escapeHtml(null) === "");

console.log("\n[12] backtest simulator");
{
  const { binPrices, positionValue, simulatePool } = await import("../scripts/backtest-sim.js");
  const prices = binPrices(1, 35, 80);
  check("above every bin the position is all SOL", Math.abs(positionValue(prices, 2).value - 1) < 1e-12 && positionValue(prices, 2).tokenValue === 0);
  const deep = positionValue(prices, prices.at(-1) / 2);
  check("below every bin the position is all token, marked down", Math.abs(deep.value - deep.tokenValue) < 1e-12 && deep.value < 0.6);

  const tier = { minFeeTvl24hPct: 0.01, maxDailyVolPct: 50, rangeVolMult: 2 };
  const screening = { feeStabilityMin: 0.3, feeStabilityMax: 3 };
  const params = { rangeVolMult: 2, stopLossPct: -10, takeProfitPct: null, outOfRangeWaitMinutes: 120, outOfRangeBinsToClose: 30, minFeePerTvl24h: null, minAgeBeforeYieldCheck: 360, cooldownHours: 1 };
  const costs = { swapFeePct: 0.6, txCostPct: 0 };
  // Calm market: closes wiggle 1.000/0.999 and every hour trades inside the range; $10 LP fees/hour on $100k TVL.
  const wiggle = h => Array.from({ length: h }, (_, i) => ({ close: i % 2 ? 0.999 : 1, low: 0.995, high: 1 }));
  const calm = simulatePool({ candles: wiggle(24 * 31), lpFees: Array(24 * 31).fill(10), tvl: 100_000, binStep: 80, tier, screening, params, costs });
  check("calm pool: one position held to the end", calm.trades.length === 1 && calm.trades[0].reason === "end of data", JSON.stringify(calm.trades.map(t => t.reason)));
  check("calm pool earns ~0.24%/day of fees", calm.monthlyPct > 6 && calm.monthlyPct < 8, String(calm.monthlyPct));

  const dumpCandles = [...wiggle(30), ...Array.from({ length: 20 }, (_, i) => { const p = 1 - 0.02 * (i + 1); return { close: p, low: p, high: p + 0.01 }; })];
  const dump = simulatePool({ candles: dumpCandles, lpFees: Array(dumpCandles.length).fill(10), tvl: 100_000, binStep: 80, tier, screening, params, costs });
  check("dump triggers the stop loss", dump.stops === 1 && dump.trades[0].pnlPct <= -10, JSON.stringify(dump.trades));

  const pumpCandles = [...wiggle(30), ...Array.from({ length: 10 }, () => ({ close: 1.05, low: 1.05, high: 1.05 }))];
  const pump = simulatePool({ candles: pumpCandles, lpFees: Array(pumpCandles.length).fill(10), tvl: 100_000, binStep: 80, tier, screening, params, costs });
  check("price above the range closes after the OOR wait", pump.trades[0]?.reason === "OOR" && pump.trades[0].exit - 30 >= 1, JSON.stringify(pump.trades));

  const noFees = simulatePool({ candles: wiggle(24 * 5), lpFees: Array(24 * 5).fill(0), tvl: 100_000, binStep: 80, tier, screening, params, costs });
  check("no fees means the entry gate never opens", noFees.trades.length === 0);
}

console.log("\n[13] strategy lab — shapes, regimes, policy");
{
  const { buildPosition, valueAt, feeShare, classifyRegime } = await import("../scripts/backtest-sim.js");
  const { learnPolicy, choose, evaluate, SKIP } = await import("../scripts/policy.js");
  const two = buildPosition({ entryPrice: 1, binStep: 100, side: "two", shape: "spot", binsBelow: 11, binsAbove: 10 });
  check("two-sided position is worth 1 at entry", Math.abs(valueAt(two, 1).value - 1) < 1e-9);
  check("two-sided gains a little on a rise and loses on a fall", valueAt(two, 1.05).value > 1 && valueAt(two, 0.95).value < 1);
  check("two-sided holds token above entry", two.tokenWeight > 0.4 && two.tokenWeight < 0.5);
  const curve = buildPosition({ entryPrice: 1, binStep: 100, side: "two", shape: "curve", binsBelow: 11, binsAbove: 10 });
  const bidask = buildPosition({ entryPrice: 1, binStep: 100, side: "two", shape: "bidask", binsBelow: 11, binsAbove: 10 });
  check("curve earns more than spot at the centre, bid-ask less", feeShare(curve, 0.999, 1.001) > 1 && feeShare(bidask, 0.999, 1.001) < 1);
  check("outside the range there is no fee share", feeShare(two, 2, 2.1) === 0);

  const series = f => Array.from({ length: 100 }, (_, i) => ({ close: f(i) * (1 + (i % 2) * 0.01) }));
  check("rising series is an up regime", classifyRegime(series(i => 1 + i * 0.005), 99)?.trend === "up");
  check("falling series is a down regime", classifyRegime(series(i => 2 - i * 0.01), 99)?.trend === "down");
  check("flat series is a range regime", classifyRegime(series(() => 1), 99)?.trend === "range");
  check("not enough history has no regime", classifyRegime(series(() => 1), 50) === null);

  const { pickShape } = await import("../standalone/regime.js");
  const sc = { strategy: "auto", regimeFallback: "bid_ask", regimeStrategies: { "down/high": "curve", "up/high": "skip" } };
  check("auto maps a regime to its shape", pickShape({ key: "down/high" }, sc).shape === "curve");
  check("auto can skip a regime", pickShape({ key: "up/high" }, sc).shape === "skip");
  check("unmapped regime uses the fallback", pickShape({ key: "range/low" }, sc).shape === "bid_ask");
  check("unknown regime uses the fallback", pickShape(null, sc).shape === "bid_ask");
  check("fixed strategy ignores the regime", pickShape({ key: "up/high" }, { ...sc, strategy: "spot" }).shape === "spot");
  const tuned = pickShape({ key: "down/high" }, { ...sc, regimeStrategies: { "down/high": { shape: "curve", rangeVolMult: 3, stopLossPct: null, outOfRangeWaitMinutes: 240, fitMeanPct: 1, n: 30 } } });
  check("tuned entry returns shape and overrides only", tuned.shape === "curve" && tuned.overrides.rangeVolMult === 3 && tuned.overrides.stopLossPct === null && tuned.overrides.outOfRangeWaitMinutes === 240 && !("n" in tuned.overrides));
  const lab = { ...sc, regimeStrategies: { "range/low": "spot" }, labelStrategies: { lst: "skip", calm: { shape: "bid_ask", rangeVolMult: 4, stopLossPct: -10 }, meme: "regime", volatile: { regimes: { "range/low": "curve" } } } };
  check("label skip wins over the regime", pickShape({ key: "range/low" }, lab, "lst").shape === "skip");
  check("label fixed entry ignores the regime", pickShape({ key: "up/high" }, lab, "calm").shape === "bid_ask" && pickShape({ key: "up/high" }, lab, "calm").overrides.stopLossPct === -10);
  check("label 'regime' uses the global regime map", pickShape({ key: "range/low" }, lab, "meme").shape === "spot");
  check("label regime map overrides the global map", pickShape({ key: "range/low" }, lab, "volatile").shape === "curve");
  check("unlabeled coin follows unlabeledStrategy", pickShape({ key: "range/low" }, { ...lab, unlabeledStrategy: "skip" }).shape === "skip" && pickShape({ key: "range/low" }, lab).shape === "spot");
  const { choosePool, fittedBinStep } = await import("../standalone/screening.js");
  const cand = (address, binStep, tvl, fee, vol = 3) => ({ address, tvl, daily_vol_pct: vol, regime: { key: "range/low" }, pool_config: { bin_step: binStep }, fee_tvl_ratio: { "24h": fee } });
  const pools = [cand("A", 80, 2e6, 0.03), cand("B", 15, 2e5, 0.20), cand("C", 4, 2e4, 0.11)];
  const rules = r => ({ ...lab, labelPoolRules: { calm: r }, labelStrategies: { calm: "bid_ask" } });
  const pickFor = r => choosePool(pools, { label: "calm", tier: { rangeVolMult: 2 }, strategy: rules(r) }).pool.address;
  check("pool rules pick by fee, tvl, largest and smallest", pickFor("fee24") === "B" && pickFor("tvl") === "A" && pickFor("largest") === "A" && pickFor("smallest") === "C");
  const fitStep = fittedBinStep(2 * 3);
  check("fit picks the bin step whose 35-bin ladder spans the target range", pickFor("fit") === "B" && fitStep > 17 && fitStep < 18.5, String(fitStep)); // 6% over 35 bins ≈ 17.7 bps
  check("all-skip candidates yield no pool", choosePool(pools, { label: "lst", tier: { rangeVolMult: 2 }, strategy: { ...lab, labelPoolRules: {} } }).pool === null);
  const savedLabels = config.strategy.coinLabels;
  config.strategy.coinLabels = { X: { symbol: "X", label: "moonshot" } };
  check("unknown coin label is reported", validateConfig().some(p => p.includes("moonshot")));
  config.strategy.coinLabels = savedLabels;
  const savedMap = config.strategy.regimeStrategies;
  config.strategy.regimeStrategies = { "down/high": { shape: "curve", stopLossPct: 5 } };
  check("tuned entry with a positive stop is reported", validateConfig().some(p => p.includes("stopLossPct")));
  config.strategy.regimeStrategies = { "down/high": { shape: "curve", rangeVolMult: 3, stopLossPct: null, outOfRangeWaitMinutes: 240 } };
  check("valid tuned entry validates", !validateConfig().some(p => p.includes("regimeStrategies")), validateConfig().join("; "));
  config.strategy.regimeStrategies = savedMap;
  const savedStrategy = config.strategy.strategy;
  config.strategy.strategy = "zigzag";
  check("invalid strategy is reported", validateConfig().some(p => p.includes("strategy")));
  config.strategy.strategy = savedStrategy;

  const row = (trend, a, b) => ({ features: { trend }, returns: { a, b } });
  const rows = [...Array(20)].flatMap(() => [row("up", 2, 1), row("down", -3, -1)]);
  const policy = learnPolicy(rows, { levels: [["trend"], []], minSamples: 10 });
  check("policy picks the best strategy per regime", choose(policy, { trend: "up" }) === "a");
  check("policy skips a regime where everything loses", choose(policy, { trend: "down" }) === SKIP);
  check("unseen regime falls back to the global entry", choose(policy, { trend: "range" }) === policy.table["*"].pick);
  const score = evaluate(rows, r => choose(policy, r.features));
  check("evaluation counts skips as zero", score.traded === 20 && Math.abs(score.mean - 1) < 1e-9);
}

console.log("\n[14] indicators — ER, structure, ZLEMA, ATR, ADX, resample");
{
  const ind = await import("../standalone/indicators.js");
  const bar = (close, i, spread = 0.5) => ({ timestamp: 1_800_000_000 + i * 3600, open: close, high: close + spread, low: close - spread, close });
  const chop = Array.from({ length: 40 }, (_, i) => bar(100 + (i % 2 ? 1 : -1), i));
  const up = Array.from({ length: 40 }, (_, i) => bar(100 + i, i));
  const down = Array.from({ length: 40 }, (_, i) => bar(140 - i, i));
  const mc = ind.erMetrics(chop, 39, 24), mu = ind.erMetrics(up, 39, 24), md = ind.erMetrics(down, 39, 24);
  check("chop has low ER and balanced direction", mc.er < 0.1 && mc.directionBalance > 0.9);
  check("trend has ER ≈ 1", mu.er > 0.99 && md.er > 0.99);
  check("ER classes: chop / bull / bear", ind.classifyEr(mc) === "chop" && ind.classifyEr(mu) === "bull" && ind.classifyEr(md) === "bear");
  check("ER needs a full window", ind.erMetrics(up, 10, 24) === null);

  // Swing high at bar 5 (confirmed at bar 8), then a close above it → bullish break; later a close below swing low.
  const closes = [10, 11, 12, 13, 14, 20, 13, 12, 11, 22, 23, 24, 23, 22, 21, 20, 9];
  const seq = closes.map((c, i) => ({ timestamp: i * 3600, open: c, high: c + (i === 5 ? 1 : 0.1), low: c - 0.1, close: c }));
  const st = ind.structureSeries(seq, 3);
  check("no break before the swing is confirmed", st.slice(0, 9).every(s => s.event === null));
  check("close above the confirmed swing high is a bullish CHoCH", st[9].event === "CHOCH+" && st[9].trend === 1);
  const lowIdx = st.findIndex(s => s.event === "CHOCH-");
  check("close below a confirmed swing low flips to bearish", lowIdx === -1 || st[lowIdx].trend === -1);

  const reversal = [...Array.from({ length: 40 }, (_, i) => bar(100 + i, i)), ...Array.from({ length: 40 }, (_, i) => bar(139 - 2 * i, 40 + i))];
  const zl = ind.atrZlemaTrend(reversal);
  check("ATR ZLEMA is up in the rally and flips down in the selloff", zl[39] === 1 && zl.at(-1) === -1);

  const flatTr = Array.from({ length: 30 }, (_, i) => bar(100, i, 1));
  check("ATR of constant 2-point bars is 2 (2%)", Math.abs(ind.atrPct(flatTr, 29, 14) - 2) < 1e-9);
  const adxTrend = ind.adxSeries(up).at(-1), adxChop = ind.adxSeries(chop).at(-1);
  check("ADX is high in a trend and low in chop", adxTrend > 50 && adxChop < 25, `${adxTrend} / ${adxChop}`);

  const hourly = Array.from({ length: 10 }, (_, i) => bar(100 + i, i));
  const { bars, closeIndex } = ind.resample(hourly, 4);
  check("resample keeps only complete 4h bars", bars.every((b, k) => closeIndex[k] - (k ? closeIndex[k - 1] : -1) <= 4) && bars.length <= 2);
  check("zigzag swing size of a ±2% oscillation", Math.abs(ind.zigzagSwingPct(Array.from({ length: 30 }, (_, i) => bar(100 * (i % 4 < 2 ? 1 : 1.02), i)), 29, 30, 1) - 2) < 0.1);
}

{
  const ind = await import("../standalone/indicators.js");
  const bar = (close, i, h = 1) => ({ timestamp: 1_800_000_000 + i * 3600 * h, open: close, high: close + 0.5, low: close - 0.5, close });
  const now = 1_800_000_000 + 40 * 3600;
  check("closedOnly drops a still-forming candle", ind.closedOnly([bar(1, 38), bar(1, 39), bar(1, 40)], 1, now + 60).length === 2);
  const down1h = Array.from({ length: 60 }, (_, i) => bar(200 - i, i)), down4h = Array.from({ length: 30 }, (_, i) => bar(200 - 4 * i, i, 4));
  const snap = ind.indicatorSnapshot(down1h, down4h);
  check("downtrend snapshot is bear on 4h ER and ZLEMA down", snap.regime4 === "bear" && snap.zl1 === -1 && snap.zl4 === -1);
  check("calm gate closed and exits fire in a downtrend", !ind.INDICATOR_GATES.er4_chop_and_struct(snap) && ind.INDICATOR_EXITS.zl1_down(snap) && ind.INDICATOR_EXITS.zl4_down(snap));
  const chop1h = Array.from({ length: 60 }, (_, i) => bar(100 + (i % 2 ? 1 : -1), i)), chop4h = Array.from({ length: 30 }, (_, i) => bar(100 + (i % 2 ? 1 : -1), i, 4));
  const calm = ind.indicatorSnapshot(chop1h, chop4h);
  check("chop snapshot opens the ER-chop gate and the ADX gate", ind.INDICATOR_GATES.er4_chop(calm) && ind.INDICATOR_GATES.adx1_low(calm), JSON.stringify({ r: calm.regime4, adx: calm.adx1 }));
}

console.log("\n[15] Secret key formats");
{
  const { parseSecretKey } = await import("../secret-key.js");
  const kp = Keypair.generate();
  const pub = kp.publicKey.toBase58();
  const seed = kp.secretKey.slice(0, 32);
  const same = (raw, label) => { try { check(label, parseSecretKey(raw).publicKey.toBase58() === pub); } catch (e) { check(label, false, e.message); } };
  same(bs58.encode(kp.secretKey), "base58 64-byte key");
  same(JSON.stringify([...kp.secretKey]), "JSON byte array");
  same(` "${bs58.encode(kp.secretKey)}" `, "quoted and padded base58");
  same(Buffer.from(kp.secretKey).toString("hex"), "hex 64-byte key");
  same(bs58.encode(seed), "base58 32-byte seed");
  const truncated = bs58.encode(kp.secretKey.slice(0, 60));
  let err = "";
  try { parseSecretKey(truncated); } catch (e) { err = e.message; }
  check("truncated key reports byte count", err.includes("60 bytes"), err);
  check("error never echoes the secret", err && !err.includes(truncated));
  try { parseSecretKey("word ".repeat(12)); check("seed phrase rejected", false); } catch (e) { check("seed phrase rejected", /Seed phrases/.test(e.message)); }
}

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
