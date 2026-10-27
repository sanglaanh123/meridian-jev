// Standalone orchestrator: Meteora pool scanner → tiered bluechip/mid-cap
// screening → revalidated deploy → deterministic exits. No LLM authority.
//
// Entry and exit paths are independent: exits keep running while a signal is
// being screened, and wallet mutations are serialized by the wallet lock
// (close_position > other writes > deploy_position) in standalone/transactions.js.

import fs from "node:fs";
import { config, computeDeployAmount, validateConfig } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { sendMessage as tgSend, isEnabled as tgEnabled } from "../telegram.js";
import { MonitorStore, finishSignal, finishStaleSignals } from "./store.js";
import { startScanner, stats as scanStats } from "./scanner.js";
import { screenMint, rejectPool, tierLimits, indicatorsFor, summarizeIndicators } from "./screening.js";
import { INDICATOR_EXITS } from "./indicators.js";
import { poolIndicators } from "./meteora.js";
import { getPool } from "./meteora.js";
import { getMyPositions } from "../tools/dlmm.js";
import { executeTool } from "../tools/executor.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTrackedPositions, getTrackedPosition, confirmPeak, updatePnlAndCheckExits, registerExitSignal, syncOpenPositions } from "../state.js";
import { recordPositionSnapshot } from "../pool-memory.js";
import { getDeterministicCloseRule, computeBinsBelow } from "../exit-rules.js";
import { startAdmin } from "./telegram-admin.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let store = null;
let stopScanner = null;
let lockPath = null;
let stopAdmin = null;
let shuttingDown = false;
let manageBusy = false;
let pollBusy = false;
let pursuing = false;
const timers = {};
const signalQueue = [];

async function notify(text) {
  try { if (tgEnabled()) await tgSend(text); } catch { /* notifications are best-effort */ }
}

// ─── Signal pursuit ──────────────────────────────────────────────────────────

function onSignal(signal) {
  signalQueue.push(signal);
  void drainSignals();
}

async function drainSignals() {
  if (pursuing) return;
  pursuing = true;
  try {
    while (signalQueue.length && !shuttingDown) {
      const signal = signalQueue.shift();
      try {
        await pursueSignal(signal);
      } catch (e) {
        // A state-write failure here must never escape as an unhandled rejection.
        try { finishSignal(store, signal, `error: ${e.message}`, config.standalone); } catch (err) { log("signal_error", `Could not finish signal ${signal.mint.slice(0, 8)}: ${err.message}`); }
        log("signal_error", `Signal ${signal.mint.slice(0, 8)} aborted: ${e.message}`);
      }
    }
  } finally {
    pursuing = false;
  }
}

// Screen and enter within the signal deadline. Terminal outcomes finish the
// signal; temporary failures retry every retrySec until the deadline expires.
async function pursueSignal(signal) {
  log("signal", `Scanner signal on ${signal.mint.slice(0, 8)} [${signal.tier}] pool ${signal.pool?.slice(0, 8)} (${(signal.reasons ?? []).join(", ")}) — screening with ${config.standalone.screeningDeadlineSec}s deadline`);
  let lastReason = "no attempt";
  while (!shuttingDown && !signal.done && Date.now() < signal.deadline) {
    const reason = await attemptEntry(signal);
    if (reason == null) return;
    lastReason = reason;
    const wait = Math.min(config.standalone.retrySec * 1000, signal.deadline - Date.now());
    if (wait > 0) await sleep(wait);
  }
  if (!signal.done) {
    finishSignal(store, signal, lastReason, config.standalone);
    log("signal", `Signal ${signal.mint.slice(0, 8)} expired: ${lastReason}`);
  }
}

// One entry attempt. Returns null when the signal is finished (entered,
// terminal rejection, or fatal condition), or a reason string to retry.
async function attemptEntry(signal) {
  const mint = signal.mint;
  const attempt = store.data.attempts[mint];
  // One attempt chain per mint; bounded retries only for temporary failures.
  if (attempt && ["entered", "proposed", "submitting"].includes(attempt.status)) {
    finishSignal(store, signal, `mint already attempted (${attempt.status})`, config.standalone);
    return null;
  }
  if (attempt?.status === "failed" && (attempt.failures ?? 0) >= 2) {
    finishSignal(store, signal, "deploy failed repeatedly", config.standalone);
    return null;
  }

  // A failed position read is unavailable data, never "no positions".
  const positions = await getMyPositions({ force: true }).catch(() => null);
  if (!positions || positions.error || !Array.isArray(positions.positions)) return "position read unavailable";
  if (positions.positions.length >= config.risk.maxPositions) {
    finishSignal(store, signal, "portfolio full", config.standalone);
    return null;
  }

  // Focused screening: the signalled pool, re-read fresh.
  let screened;
  try {
    screened = await screenMint(mint, { poolAddress: signal.pool });
  } catch (e) {
    return `screening error: ${e.message}`;
  }
  if (!screened.pass) {
    if (screened.terminal) {
      finishSignal(store, signal, `blocked: ${screened.reason}`, config.standalone);
      return null;
    }
    return screened.reason;
  }
  const tier = screened.tier;
  const t = config.screening.tiers[tier];

  // Per-tier position cap, counted from the tier recorded at entry.
  const openByTier = {};
  for (const p of positions.positions) {
    const pt = getTrackedPosition(p.position)?.tier;
    if (pt) openByTier[pt] = (openByTier[pt] ?? 0) + 1;
  }
  const limits = tierLimits(openByTier, tier);
  if (limits.full) {
    finishSignal(store, signal, `${tier} tier full (${limits.open}/${limits.max})`, config.standalone);
    return null;
  }

  const gate = await finalRecheck(signal, screened);
  if (gate) return gate;

  const balances = await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) return "balance read unavailable";
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) {
    finishSignal(store, signal, "insufficient spendable SOL", config.standalone);
    return null;
  }
  // Tier sizing never drops below the configured minimum deploy amount.
  const amountY = parseFloat(Math.max(config.management.deployAmountSol, computeDeployAmount(balances.sol) * t.sizeMult).toFixed(2));

  const pool = screened.pool;
  const binStep = pool.pool_config.bin_step;
  // Tuned regime entries may override the tier range, stop and OOR wait for this position.
  const ov = screened.overrides ?? {};
  const binsBelow = computeBinsBelow(pool.daily_vol_pct, binStep, ov.rangeVolMult ?? t.rangeVolMult);
  // Checkpoint before building anything: a crash mid-sequence leaves a
  // recovery pointer instead of a silent duplicate-entry risk.
  store.data.attempts[mint] = {
    at: Date.now(), mint, pool: pool.address, source: signal.source ?? "meteora", tier, reasons: signal.reasons ?? [],
    strategy: screened.shape, regime: pool.regime?.key ?? null, label: screened.label ?? null, indicators: screened.indicators ?? null,
    status: "submitting", failures: attempt?.failures ?? 0, position: null, txs: [],
    ...(screened.jev ? { jev: screened.jev } : {}),
  };
  store.save();

  let submitted = 0;
  const result = await executeTool("deploy_position", {
    pool_address: pool.address,
    pool_name: pool.name,
    amount_y: amountY,
    bins_below: binsBelow,
    strategy: screened.shape,
    stop_loss_pct: "stopLossPct" in ov ? ov.stopLossPct : t.stopLossPct,
    oor_wait_minutes: ov.outOfRangeWaitMinutes ?? null,
    bin_step: binStep,
    volatility: pool.daily_vol_pct,
    fee_tvl_ratio: pool.fee_tvl_ratio["24h"],
    tier,
    label: screened.label ?? null,
    before_submit: async () => {
      // Gate only the first transaction of the sequence. Once creation has
      // been sent, completing the sequence is safer than abandoning a
      // half-built position.
      if (submitted++ > 0) return;
      const fresh = await finalRecheck(signal, screened);
      if (fresh) throw new Error(`Pre-submit recheck failed: ${fresh}`);
    },
    on_prepared: position => {
      store.data.attempts[mint].position = position;
      store.save();
    },
  }).catch(e => ({ error: e.message }));

  const record = store.data.attempts[mint];
  const ok = result && result.success !== false && !result.error && !result.blocked;
  if (ok) {
    record.status = result.dry_run ? "proposed" : "entered";
    record.position = result.position ?? record.position;
    record.txs = result.txs ?? [];
    record.amountSol = amountY;
    store.save();
    finishSignal(store, signal, record.status === "proposed" ? "shadow proposal recorded" : "entered", config.standalone);
    const label = result.dry_run ? "[SHADOW] Would deploy" : "Deployed";
    log("entry", `${label} ${amountY} SOL → ${pool.name ?? pool.address.slice(0, 8)} [${tier}] ${screened.shape} (${screened.shapeReason}; ${binsBelow} bins below, bin step ${binStep}, vol ${pool.daily_vol_pct.toFixed(1)}%/day, fee/TVL ${pool.fee_tvl_ratio["24h"].toFixed(3)}%/day)`);
    void notify(`${result.dry_run ? "🕯️ Shadow proposal" : "✅ Entry"}: ${amountY} SOL → ${pool.name ?? pool.address.slice(0, 8)} [${tier}] ${screened.shape}\n${screened.shapeReason} · fee/TVL ${pool.fee_tvl_ratio["24h"].toFixed(3)}%/day · vol ${pool.daily_vol_pct.toFixed(1)}%/day · ${binsBelow} bins${screened.jev ? `\nJev: ${screened.jev.decision} — ${screened.jev.reason}` : ""}`);
    return null;
  }

  record.status = "failed";
  record.failures = (record.failures ?? 0) + 1;
  record.error = result?.error || result?.reason || "unknown";
  if (Array.isArray(record.txs) && record.txs.length > 0) record.note = "transaction submitted before failure — outcome uncertain";
  store.save();
  return `deploy failed (${record.error})`;
}

// Immediate pre-entry conditions: the pool still passes its tier rules, the
// market has not run away since screening, and spendable funds cover the
// entry. Returns null when everything holds, else the reason.
async function finalRecheck(signal, screened) {
  try {
    const fresh = await getPool(screened.pool.address);
    // Volatility comes from the screening candles; a minute later it cannot have moved.
    const why = rejectPool(fresh, signal.mint, config.screening.tiers[screened.tier], config.screening, { volatility: false });
    if (why) return `pool no longer qualifies: ${why}`;
    const base = Number(screened.pool.current_price);
    const now = Number(fresh.current_price);
    if (!(base > 0) || !(now > 0)) return "price unavailable for move check";
    const movePct = Math.abs(now - base) / base * 100;
    if (movePct > config.standalone.maxPriceMovePct) return `price moved ${movePct.toFixed(1)}% since screening`;
  } catch (e) {
    return `fresh pool read failed (${e.message})`;
  }
  const balances = await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) return "balance read unavailable";
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) return "insufficient spendable SOL";
  return null;
}

// ─── Exits (deterministic, no LLM) ──────────────────────────────────────────

// One management pass: trailing/rule exits and fee claims. Never triggers
// screening — an empty portfolio just waits for the next scanner signal.
export async function manageOnce() {
  if (manageBusy || shuttingDown) return null;
  manageBusy = true;
  try {
    const live = await getMyPositions({ force: true }).catch(() => null);
    if (!live || live.error || !Array.isArray(live.positions)) {
      log("manage_warn", "Position read unavailable — holding this cycle");
      return null;
    }
    syncOpenPositions(live.positions.map(p => p.position));
    if (live.positions.length === 0) return "No open positions";
    for (const p of live.positions) {
      recordPositionSnapshot(p.pool, p);
      // Slow backstop: raise peaks immediately and act on detected exits.
      // Real-time confirmation lives in the fast poller below.
      confirmPeak(p.position, p.pnl_pct, 1);
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      const closeRule = exit
        ? { action: "CLOSE", rule: "exit", reason: exit.reason }
        : getDeterministicCloseRule(p, config.management);
      let action = null;
      if (closeRule?.action === "CLOSE") {
        action = { tool: "close_position", args: { position_address: p.position, reason: closeRule.reason }, label: `close (${closeRule.reason})` };
      } else {
        const indicatorExit = await checkIndicatorExit(p);
        if (indicatorExit) action = { tool: "close_position", args: { position_address: p.position, reason: indicatorExit }, label: `close (${indicatorExit})` };
        else if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
          action = { tool: "claim_fees", args: { position_address: p.position }, label: "claim fees" };
        }
      }
      // LLM-set free-text instructions have no execution path in standalone — hold.
      if (!action) continue;
      const res = await executeTool(action.tool, action.args).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      log("manage", `${p.pair ?? p.position.slice(0, 8)}: ${action.label} ${ok ? "done" : `FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
    return null;
  } finally {
    manageBusy = false;
  }
}

// Indicator exit for the position's coin label, checked on the slow management pass
// only. Candle reads are cached per pool for 10 minutes; unreadable data never exits.
const indicatorCache = new Map();
async function checkIndicatorExit(p) {
  const exit = indicatorsFor(getTrackedPosition(p.position)?.label ?? null).exit;
  if (exit === "none" || !p.pool) return null;
  let hit = indicatorCache.get(p.pool);
  if (!hit || Date.now() - hit.at > 10 * 60_000) {
    try { hit = { at: Date.now(), snap: summarizeIndicators(await poolIndicators(p.pool)) }; indicatorCache.set(p.pool, hit); }
    catch (e) { log("manage_warn", `${p.pair ?? p.position.slice(0, 8)}: indicator read failed (${e.message}) — holding`); return null; }
  }
  return INDICATOR_EXITS[exit](hit.snap.raw) ? `indicator exit ${exit} (${hit.snap.text})` : null;
}

// Fast exit poller (RPC + Meteora deposits, no LLM). An exit fires only after
// `confirmTicks` consecutive confirming polls; confirmed exits close directly.
function startPnlPoller() {
  const pollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  timers.pnl = setInterval(async () => {
    if (manageBusy || pollBusy || shuttingDown) return;
    if (getTrackedPositions(true).length === 0) return;
    pollBusy = true;
    try {
      const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!live?.positions?.length) return;
      for (const p of live.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks);
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null;
        if (exit) { signal = exit.action ?? "EXIT"; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; }
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!signal || !fire) continue;
        log("poll", `Exit confirmed (${confirmTicks} ticks): ${p.pair ?? p.position.slice(0, 8)} — ${reason} — closing`);
        manageBusy = true; // hold the slow cycle off this position
        try {
          const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
          const ok = res?.success !== false && !res?.error && !res?.blocked;
          log("poll", `${p.pair ?? p.position.slice(0, 8)}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
        } finally {
          manageBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      pollBusy = false;
    }
  }, pollMs);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

// DRY_RUN can be forced from .env without shadowMode; report what actually happens.
const modeLabel = () => config.standalone.shadow ? "shadow" : process.env.DRY_RUN === "true" ? "dry-run" : "live";

function startHeartbeat() {
  timers.heartbeat = setInterval(() => {
    const active = Object.values(store.data.signals).filter(s => !s.done).length;
    const last = scanStats.lastScanAt ? `${Math.round((Date.now() - scanStats.lastScanAt) / 60_000)}m ago` : "never";
    log("heartbeat", `mode=${modeLabel()} | scanner scans=${scanStats.scans} last=${last} listed=${scanStats.listed} screened=${scanStats.candidates} emitted=${scanStats.emitted} errors=${scanStats.errors} | signals active=${active} queued=${signalQueue.length}`);
    store.prune();
    store.save();
  }, 60_000);
}

function acquireLock() {
  lockPath = repoPath("standalone.lock");
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* not running or invalid pid */ }
    if (alive && pid !== process.pid) throw new Error(`Another standalone instance is running (pid ${pid}) — refusing to start`);
    log("runtime", `Removing stale standalone lock (pid ${pid || "unknown"} is not running)`);
    fs.rmSync(lockPath);
  }
  fs.writeFileSync(lockPath, String(process.pid));
}

async function shutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("runtime", `${signalName} received — shutting down`);
  for (const timer of Object.values(timers)) clearInterval(timer);
  try { stopAdmin?.(); } catch { /* best-effort */ }
  try { stopScanner?.(); } catch { /* best-effort */ }
  // Best-effort stop notice; never let a slow Telegram call hold shutdown.
  await Promise.race([notify(`🛑 Meridian stopped (${signalName})`), sleep(3000)]).catch(() => {});
  try { if (lockPath) fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  process.exit(0);
}

export async function startStandalone() {
  if (!config.standalone.rpcUrl) throw new Error("Standalone requires RPC_URL");
  const problems = validateConfig();
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  acquireLock();

  store = new MonitorStore();
  const stale = finishStaleSignals(store, config.standalone);
  if (stale) log("runtime", `Cleared ${stale} signal(s) left unfinished by the previous run`);
  if (config.jev.mode === "approve" && !process.env.TYPESAFE_API_KEY) throw new Error("jevMode=approve requires TYPESAFE_API_KEY");
  for (const [mint, attempt] of Object.entries(store.data.attempts)) {
    if (attempt.status === "submitting") {
      log("runtime_warn", `Mint ${mint.slice(0, 8)} was mid-submit at shutdown (position ${attempt.position ?? "unknown"}, txs ${attempt.txs?.length ?? 0}) — reconcile on-chain before re-enabling entries`);
    }
  }

  const tiers = config.screening.enabledTiers.join("+");
  const modeText = { shadow: "SHADOW MODE (proposals recorded, nothing submitted)", "dry-run": "DRY RUN (nothing submitted)", live: "LIVE MODE" }[modeLabel()];
  log("runtime", `Standalone starting — ${modeText} | tiers=${tiers} | scanner every ${config.scanner.scanMin}m${config.scanner.enabled ? "" : " (disabled — exits only)"} | screening deadline=${config.standalone.screeningDeadlineSec}s`);

  // Entries come only from scanner signals; exits run on their own cadences.
  if (config.scanner.enabled) stopScanner = startScanner({ store, onSignal, options: config.standalone });
  timers.manage = setInterval(() => { void manageOnce(); }, Math.max(1, config.schedule.managementIntervalMin) * 60_000);
  startPnlPoller();
  startHeartbeat();
  void manageOnce();
  stopAdmin = startAdmin({
    scanner: scanStats,
    activeSignals: () => Object.values(store.data.signals).filter(s => !s.done).length,
  });

  void notify(`🤖 Meridian started — ${modeLabel().toUpperCase()}\ntiers: ${tiers} | scanner every ${config.scanner.scanMin}m | exits: ${config.pnl.pollIntervalSec}s poller`);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log("runtime", `Running — exits every ${config.schedule.managementIntervalMin}m + ${config.pnl.pollIntervalSec}s poller; scanning Meteora pools`);
}
