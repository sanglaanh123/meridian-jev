// Meteora pool scanner — the only entry trigger. Every scanMin it lists token/SOL
// DLMM pools, pre-filters them with the tier pool rules (no extra calls), fully
// screens the best few mints and emits at most maxSignalsPerScan signals into
// the same pursuit path the runtime uses. No network on import.
import { config } from '../config.js';
import { log } from '../logger.js';
import { listPools } from './meteora.js';
import { tierFor, rejectPool, screenMint } from './screening.js';
import { acceptPoolSignal, finishSignal, signalBlocked } from './store.js';
import { getMyPositions } from '../tools/dlmm.js';

export const stats = { scans: 0, listed: 0, candidates: 0, emitted: 0, errors: 0, lastScanAt: null, rpcError: null };

// Mints whose screening failed for a temporary reason (RPC/API errors, stale data) are
// skipped for two scans, so one bad batch cannot block the shortlist forever.
const deferred = new Map();

/** Cheapest server-side filter that still covers every enabled tier. */
export function listFilter(s = config.screening) {
  const tiers = s.enabledTiers.map(name => s.tiers[name]).filter(Boolean);
  return [
    'is_blacklisted=false',
    `token_y=${config.tokens.SOL}`,
    `tvl>=${Math.min(...tiers.map(t => t.minTvl))}`,
    `volume_24h>=${Math.min(...tiers.map(t => t.minVolume24h))}`,
  ];
}

/** Pure pre-filter over list results: best pool per mint that passes its tier's pool rules. */
export function preselect(pools, { skipMint = () => false, s = config.screening, now = Date.now() } = {}) {
  const byMint = new Map();
  for (const p of pools) {
    const mint = p?.token_x?.address;
    if (!mint || byMint.has(mint) || skipMint(mint)) continue;
    const tier = tierFor(p.token_x.market_cap, s);
    if (!tier) continue;
    if (rejectPool(p, mint, s.tiers[tier], s, { volatility: false, now })) continue;
    byMint.set(mint, { mint, pool: p.address, tier, metrics: { tvl: p.tvl, fee_tvl_24h: p.fee_tvl_ratio?.['24h'], volume_24h: p.volume?.['24h'], bin_step: p.pool_config?.bin_step }, reasons: [`${tier}`, `fee/TVL ${Number(p.fee_tvl_ratio?.['24h']).toFixed(3)}%/day`] });
  }
  return [...byMint.values()];
}

/** Round-robin across tiers, keeping each tier's fee/TVL order — mid caps out-earn
 * bluechips on raw fee/TVL, so a plain sort would never screen a bluechip. */
export function interleaveTiers(candidates) {
  const queues = new Map();
  for (const c of candidates) queues.set(c.tier, [...(queues.get(c.tier) ?? []), c]);
  const out = [];
  while ([...queues.values()].some(q => q.length)) for (const q of queues.values()) if (q.length) out.push(q.shift());
  return out;
}

/**
 * One scan. `emit=false` is the read-only CLI preview: nothing is stored or signalled.
 * Never throws — an unreadable portfolio or API error skips the scan.
 */
export async function scanOnce({ store = null, onSignal = () => {}, emit = true, options = config.standalone, readPositions = () => getMyPositions({ force: true, silent: true }) } = {}) {
  const report = { listed: 0, candidates: [], emitted: [] };
  try {
    const positions = await readPositions();
    if (positions?.error || !Array.isArray(positions?.positions)) throw new Error('position read unavailable');
    const held = new Set(positions.positions.map(p => p.base_mint).filter(Boolean));
    const pools = await listPools({ filter: listFilter(), sort: 'fee_tvl_ratio_24h:desc', pageSize: 200 });
    report.listed = pools.length;
    const attempts = store?.data.attempts ?? {};
    const now = Date.now();
    for (const [mint, until] of deferred) if (until <= now) deferred.delete(mint);
    const skipMint = mint => held.has(mint) || deferred.has(mint) || (store && signalBlocked(store, mint)) || ['entered', 'proposed', 'submitting'].includes(attempts[mint]?.status);
    const shortlist = interleaveTiers(preselect(pools, { skipMint })).slice(0, config.scanner.maxCandidatesPerScan);
    for (const c of shortlist) {
      if (report.emitted.length >= config.scanner.maxSignalsPerScan) break;
      let verdict;
      // Screen all of the mint's pools: the coin label's pool rule picks which one to farm.
      try { verdict = await screenMint(c.mint); }
      catch (e) { verdict = { pass: false, reason: `screening error: ${e.message}` }; }
      report.candidates.push({ ...c, pass: verdict.pass, reason: verdict.reason ?? null, jev: verdict.jev?.decision ?? null });
      if (!emit || !store) continue;
      if (!verdict.pass && !verdict.terminal) deferred.set(c.mint, Date.now() + 2 * config.scanner.scanMin * 60_000);
      if (verdict.pass) {
        const signal = acceptPoolSignal(store, { ...c, pool: verdict.pool.address, tier: verdict.tier ?? c.tier, reasons: [...c.reasons, `bin step ${verdict.pool.pool_config.bin_step}`] }, options);
        if (signal) { report.emitted.push(c.mint); onSignal(signal); }
      } else if (verdict.terminal) {
        // Park terminal rejects for the cooldown so the next scans try other mints.
        const parked = acceptPoolSignal(store, c, options);
        if (parked) finishSignal(store, parked, `scanner reject: ${verdict.reason}`, options);
      }
    }
    stats.scans++; stats.listed = report.listed; stats.candidates += report.candidates.length; stats.emitted += report.emitted.length;
    stats.lastScanAt = Date.now();
    // Every screened mint failing on RPC means entries are impossible: surface it.
    const rpcFails = report.candidates.filter(c => /RPC \w+ read failed/.test(c.reason ?? ''));
    stats.rpcError = report.candidates.length && rpcFails.length === report.candidates.length ? rpcFails[0].reason.replace(/^screening error: /, '') : null;
    if (stats.rpcError) log('scanner_warn', `Every candidate failed on RPC (${stats.rpcError}) — no entries possible until the RPC recovers; check RPC_URL quota or set FALLBACK_RPC_URL`);
    log('scanner', `Scan: ${report.listed} pools listed, ${report.candidates.length} screened, ${report.emitted.length} signal(s)${report.candidates.length ? ` — ${report.candidates.map(c => `${c.mint.slice(0, 6)}[${c.tier}] ${c.pass ? 'pass' : c.reason}`).join('; ')}` : ''}`);
  } catch (e) {
    stats.errors++;
    report.error = e.message;
    log('scanner_warn', `Scan skipped: ${e.message}`);
  }
  return report;
}

export function startScanner({ store, onSignal, options = config.standalone }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await scanOnce({ store, onSignal, options }); } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, Math.max(1, config.scanner.scanMin) * 60_000);
  void tick();
  return () => clearInterval(timer);
}
