// Manual pool mode. The user names pools in config; this module resolves them,
// opens one position with the configured strategy (auto shape by default), and
// decides whether a later exit is a take-profit, a stop, or a slow rebalance.
// No network on import.
import { PublicKey } from '@solana/web3.js';
import { config, computeDeployAmount } from '../config.js';
import { log } from '../logger.js';
import { sendMessage, isEnabled as tgEnabled } from '../telegram.js';
import { getPool, listPools, poolWithVolatility } from './meteora.js';
import { pickShape } from './regime.js';
import { computeBinsBelow } from '../exit-rules.js';
import { getMyPositions } from '../tools/dlmm.js';
import { getWalletBalances } from '../tools/wallet.js';
import { isBlacklisted } from '../token-blacklist.js';

const opening = new Set();

async function notify(text) {
  try { if (tgEnabled()) await sendMessage(text); } catch { /* notifications are best-effort */ }
}

export function isPoolAddress(value) {
  const text = String(value ?? '').trim();
  try { return new PublicKey(text).toBase58() === text; }
  catch { return false; }
}

/** Exact `name` match among token-X / SOL pools. */
export function matchPoolsByName(name, pools, sol = config.tokens.SOL) {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return [];
  return (pools ?? []).filter(p =>
    String(p?.name ?? '').trim().toLowerCase() === want &&
    p?.token_y?.address === sol &&
    p?.token_x?.address &&
    p?.address
  );
}

/**
 * Address goes straight to getPool. Any other string must match exactly one
 * token/SOL pool name in the first pages of the TVL-sorted list.
 */
export async function resolveManualPool(entry, deps = {}) {
  const key = String(entry?.pool ?? '').trim();
  if (!key) return { address: null, matches: [] };
  if (isPoolAddress(key)) {
    const getPoolFn = deps.getPool ?? getPool;
    const pool = await getPoolFn(key);
    if (pool?.address !== key) return { address: null, matches: [] };
    return { address: pool.address, matches: [pool] };
  }
  const listPoolsFn = deps.listPools ?? listPools;
  const pageCap = deps.pageCap ?? 3;
  const pageSize = deps.pageSize ?? 200;
  const matches = [];
  const seen = new Set();
  for (let page = 1; page <= pageCap; page++) {
    const rows = await listPoolsFn({
      filter: [`token_y=${config.tokens.SOL}`, 'is_blacklisted=false'],
      sort: 'tvl:desc',
      pageSize,
      page,
    });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const pool of matchPoolsByName(key, rows)) {
      if (seen.has(pool.address)) continue;
      seen.add(pool.address);
      matches.push(pool);
    }
    if (matches.length > 1 || rows.length < pageSize) break;
  }
  if (matches.length !== 1) return { address: null, matches };
  return { address: matches[0].address, matches };
}

/** Safety gate for a pool the user named. Tier bands are not applied. */
export function manualSafety(pool, sol = config.tokens.SOL) {
  const mint = pool?.token_x?.address;
  if (!mint || pool?.token_y?.address !== sol) return 'Requires an exact token/SOL pool';
  if (isBlacklisted(mint)) return 'Token is blocked';
  if (pool.is_blacklisted !== false) return 'Pool blacklist status unsafe or unknown';
  if (!(Number(pool.current_price) > 0)) return 'Pool price unavailable';
  if (!(Number(pool.daily_vol_pct) > 0)) return 'Volatility unavailable';
  return null;
}

function manualKind(reason) {
  const text = String(reason || '').trim().toLowerCase();
  if (text.includes('stop loss')) return 'stop';
  if (text.includes('take profit') || text.includes('trailing tp')) return 'tp';
  if (text === 'oor' || text.includes('out of range') || text.includes('pumped far above range')) return 'rebalance';
  if (text.includes('low yield') || text.includes('indicator exit')) return 'hold';
  return 'close';
}

/**
 * Scanner positions keep their close reason. Manual positions rebalance on a
 * slow out-of-range (or a price that ran above the range), close on TP/SL,
 * and ignore low-yield and indicator exits.
 */
export function manualExitDecision(tracked, { exit = null, closeRule = null } = {}) {
  const reason = exit?.reason ?? closeRule?.reason ?? null;
  if (!reason) return null;
  if (tracked?.source !== 'manual') return { action: 'close', reason };
  const kind = manualKind(reason);
  if (kind === 'hold') return null;
  if (kind === 'rebalance') return { action: 'rebalance', reason: 'rebalance' };
  if (kind === 'stop') return { action: 'close', reason, cooldown: 'stop' };
  if (kind === 'tp') return { action: 'close', reason, cooldown: 'tp' };
  return { action: 'close', reason, cooldown: 'tp' };
}

export function manualCooldownRecord(decision, now = Date.now(), manual = config.manual) {
  if (decision?.action === 'rebalance') return { until: now, kind: 'rebalance' };
  const minutes = decision?.cooldown === 'stop' ? manual.stopCooldownMinutes : manual.reentryMinutes;
  return { until: now + minutes * 60_000, kind: decision?.cooldown ?? 'reentry' };
}

export function manualCooldownActive(record, now = Date.now()) {
  return !!record && now < record.until;
}

export function pruneManualCooldowns(cooldowns, now = Date.now()) {
  for (const [pool, record] of Object.entries(cooldowns ?? {})) {
    if (!manualCooldownActive(record, now)) delete cooldowns[pool];
  }
}

function entryTakeProfit(entry) {
  return entry.takeProfitPct !== undefined ? entry.takeProfitPct : config.manual.takeProfitPct;
}

function entryStop(entry) {
  return entry.stopLossPct != null ? entry.stopLossPct : config.manual.stopLossPct;
}

/**
 * Open one manual pool when it is flat and off cooldown. Returns null when the
 * pool is open, cooling down, or a position was submitted. Returns a reason
 * when this tick should not continue (funds, portfolio, unreadable balances).
 */
export async function openManualPool(entry, { executeTool, store, positions = null, now = Date.now() } = {}) {
  let resolved;
  try {
    resolved = await resolveManualPool(entry);
  } catch (e) {
    log('manual_warn', `Pool "${entry?.pool}" unreadable (${e.message}) — holding`);
    return null;
  }
  if (!resolved.address) {
    const found = resolved.matches.map(p => p.address).join(', ') || 'none';
    log('manual', `Pool "${entry?.pool}" matched ${resolved.matches.length} token/SOL pools (${found}) — skipping`);
    return null;
  }
  const address = resolved.address;
  if (opening.has(address)) return null;
  opening.add(address);
  try {
    return await openResolved(entry, address, { executeTool, store, positions, now });
  } catch (e) {
    log('manual_warn', `Pool ${address.slice(0, 8)}: ${e.message} — holding`);
    return null;
  } finally {
    opening.delete(address);
  }
}

async function openResolved(entry, address, { executeTool, store, positions, now }) {
  if (!store?.data?.attempts) return 'store unavailable';
  store.data.manualCooldowns ??= {};
  if (manualCooldownActive(store.data.manualCooldowns[address], now)) return null;

  let live = positions;
  if (!live || live.error || !Array.isArray(live.positions)) {
    live = await getMyPositions({ force: true }).catch(() => null);
  }
  if (!live || live.error || !Array.isArray(live.positions)) return 'position read unavailable';
  if (live.positions.length >= config.risk.maxPositions) return 'portfolio full';
  if (live.positions.some(p => p.pool === address)) return null;

  const detail = await poolWithVolatility(address);
  const why = manualSafety(detail);
  if (why) {
    log('manual', `${detail.name ?? address.slice(0, 8)}: ${why} — holding`);
    return null;
  }
  const mint = detail.token_x.address;
  if (live.positions.some(p => p.base_mint === mint)) return null;

  const attempt = store.data.attempts[mint];
  if (attempt?.status === 'submitting') return null;
  if (attempt?.status === 'proposed' && attempt.pool === address && (config.standalone.shadow || process.env.DRY_RUN === 'true')) return null;

  // The user named this pool. Issued assets such as xStocks and WBTC keep a mint
  // authority and Token-2022 extensions the scanner rejects. Those gates stay on
  // the scanner path only.

  const label = config.strategy.coinLabels[mint]?.label ?? null;
  const pick = pickShape(detail.regime, config.strategy, label);
  const listed = config.manual.pools.find(e => e.pool === address || e.pool === entry?.pool);
  const chosen = { ...listed, ...entry };
  const shape = chosen.shape ?? pick.shape;
  if (shape === 'skip') {
    log('manual', `${detail.name ?? address.slice(0, 8)}: ${pick.why} is configured to skip — holding`);
    return null;
  }
  const rangeVolMult = chosen.rangeVolMult > 0 ? chosen.rangeVolMult : (pick.overrides.rangeVolMult > 0 ? pick.overrides.rangeVolMult : 2);
  const oorWait = chosen.outOfRangeWaitMinutes ?? pick.overrides.outOfRangeWaitMinutes ?? null;
  const binStep = detail.pool_config?.bin_step;
  let binsBelow;
  try { binsBelow = computeBinsBelow(detail.daily_vol_pct, binStep, rangeVolMult); }
  catch (e) {
    log('manual', `${detail.name ?? address.slice(0, 8)}: ${e.message} — holding`);
    return null;
  }

  const balances = await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) return 'balance read unavailable';
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) return 'insufficient spendable SOL';
  const amountY = computeDeployAmount(balances.sol);
  const stopLossPct = entryStop(chosen);
  const takeProfitPct = entryTakeProfit(chosen);
  const fee = Number(detail.fee_tvl_ratio?.['24h']);

  store.data.attempts[mint] = {
    at: now, mint, pool: address, source: 'manual', tier: null, reasons: ['manual'],
    strategy: shape, regime: detail.regime?.key ?? null, label,
    status: 'submitting', failures: attempt?.failures ?? 0, position: null, txs: [],
  };
  store.save();

  let submitted = 0;
  const result = await executeTool('deploy_position', {
    pool_address: address,
    pool_name: detail.name,
    amount_y: amountY,
    bins_below: binsBelow,
    strategy: shape,
    stop_loss_pct: stopLossPct,
    take_profit_pct: takeProfitPct,
    source: 'manual',
    oor_wait_minutes: oorWait,
    bin_step: binStep,
    volatility: detail.daily_vol_pct,
    fee_tvl_ratio: Number.isFinite(fee) ? fee : null,
    tier: null,
    label,
    base_mint: mint,
    before_submit: async () => {
      if (submitted++ > 0) return;
      const fresh = await poolWithVolatility(address);
      const blocked = manualSafety(fresh);
      if (blocked) throw new Error(`Pre-submit recheck failed: ${blocked}`);
    },
    on_prepared: position => {
      store.data.attempts[mint].position = position;
      store.save();
    },
  }).catch(e => ({ error: e.message }));

  const record = store.data.attempts[mint];
  const ok = result && result.success !== false && !result.error && !result.blocked;
  if (ok) {
    record.status = result.dry_run ? 'proposed' : 'entered';
    record.position = result.position ?? record.position;
    record.txs = result.txs ?? [];
    record.amountSol = amountY;
    store.save();
    const mode = config.standalone.shadow ? 'shadow' : process.env.DRY_RUN === 'true' ? 'dry-run' : 'live';
    const labelText = result.dry_run ? `[${mode.toUpperCase()}] Would deploy` : 'Deployed';
    log('entry', `${labelText} ${amountY} SOL → ${detail.name ?? address.slice(0, 8)} [manual] ${shape} (${pick.why}; ${binsBelow} bins below, bin step ${binStep}, vol ${detail.daily_vol_pct.toFixed(1)}%/day)`);
    void notify(`${result.dry_run ? `🕯️ ${mode === 'shadow' ? 'Shadow' : 'Dry-run'} proposal` : '✅ Entry'}: ${amountY} SOL → ${detail.name ?? address.slice(0, 8)} [manual] ${shape}\n${pick.why} · vol ${detail.daily_vol_pct.toFixed(1)}%/day · ${binsBelow} bins`);
    return null;
  }
  record.status = 'failed';
  record.failures = (record.failures ?? 0) + 1;
  record.error = result?.error || result?.reason || 'unknown';
  store.save();
  log('manual_warn', `${detail.name ?? address.slice(0, 8)}: deploy failed (${record.error})`);
  return null;
}

export async function manualTick({ executeTool, store, shuttingDown = () => false } = {}) {
  if (!config.manual.pools.length || shuttingDown()) return;
  pruneManualCooldowns(store?.data?.manualCooldowns, Date.now());
  const positions = await getMyPositions({ force: true }).catch(() => null);
  if (!positions || positions.error || !Array.isArray(positions.positions)) {
    log('manual_warn', 'Position read unavailable — holding this cycle');
    return;
  }
  for (const entry of config.manual.pools) {
    if (shuttingDown()) return;
    const reason = await openManualPool(entry, { executeTool, store, positions });
    if (reason === 'portfolio full' || reason === 'insufficient spendable SOL' || reason === 'balance read unavailable' || reason === 'position read unavailable') {
      log('manual', `Manual entries paused: ${reason}`);
      return;
    }
  }
}
