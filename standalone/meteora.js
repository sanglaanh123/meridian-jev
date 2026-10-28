// Meteora DLMM Data API (https://dlmm.datapi.meteora.ag, 30 req/s, no auth).
// The only module that talks to it for pool discovery, pool state and candles.
import { config } from '../config.js';
import { fetchJson } from './rpc.js';
import { classifyRegime } from './regime.js';
import { closedOnly, indicatorSnapshot } from './indicators.js';

const BASE = 'https://dlmm.datapi.meteora.ag';

/** Paginated pool list. `filter` is an array of `<field><op><value>` clauses joined with &&. */
export async function listPools({ filter = [], sort = 'fee_tvl_ratio_24h:desc', pageSize = 200, page = null } = {}) {
  const params = new URLSearchParams({ page_size: String(pageSize), sort_by: sort });
  if (page != null) params.set('page', String(page));
  if (filter.length) params.set('filter_by', filter.join(' && '));
  const result = await fetchJson(`${BASE}/pools?${params}`);
  if (!Array.isArray(result?.data)) throw new Error('Invalid Meteora pool list response');
  return result.data;
}

/** Token-X / SOL pools for one mint, largest first. */
export async function poolsForMint(mint) {
  const pools = await listPools({ filter: [`token_x=${mint}`, `token_y=${config.tokens.SOL}`, 'is_blacklisted=false'], sort: 'tvl:desc', pageSize: 20 });
  return pools.filter(p => p.token_x?.address === mint && p.token_y?.address === config.tokens.SOL);
}

export async function getPool(address) {
  const pool = await fetchJson(`${BASE}/pools/${address}`);
  if (pool?.address !== address) throw new Error('Pool data unavailable');
  return pool;
}

export async function ohlcv(address, { timeframe = '1h', hours = 25, now = Date.now() } = {}) {
  const end = Math.floor(now / 1000);
  const params = new URLSearchParams({ timeframe, start_time: String(end - hours * 3600), end_time: String(end) });
  const result = await fetchJson(`${BASE}/pools/${address}/ohlcv?${params}`);
  return Array.isArray(result?.data) ? result.data : [];
}

/**
 * Hourly history over [startSec, endSec], paged in 99-bucket windows (the API
 * rejects larger ranges). kind: "ohlcv" (candles) or "volume/history" (volume, fees).
 */
export async function hourlyHistory(address, kind, startSec, endSec) {
  const rows = new Map();
  for (let from = startSec; from < endSec; from += 98 * 3600) {
    const params = new URLSearchParams({ timeframe: '1h', start_time: String(from), end_time: String(Math.min(endSec, from + 98 * 3600)) });
    const result = await fetchJson(`${BASE}/pools/${address}/${kind}?${params}`);
    for (const row of Array.isArray(result?.data) ? result.data : []) rows.set(row.timestamp, row);
  }
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Indicator snapshot from closed 1h (72h) and 4h (~16 days) candles. */
export async function poolIndicators(address) {
  const [h1, h4] = await Promise.all([ohlcv(address, { hours: 72 }), ohlcv(address, { timeframe: '4h', hours: 392 })]);
  const c1h = closedOnly(h1, 1), c4h = closedOnly(h4, 4);
  if (c1h.length < 30 || c4h.length < 12) throw new Error('Not enough candles for indicators');
  return indicatorSnapshot(c1h, c4h);
}

/**
 * Daily realized volatility (%) from hourly closes: stdev of log returns × √24.
 * Returns null with fewer than 12 usable candles — missing data is never "calm".
 */
export function realizedVolatility(candles) {
  const closes = (Array.isArray(candles) ? candles : []).map(c => Number(c?.close)).filter(n => Number.isFinite(n) && n > 0);
  if (closes.length < 12) return null;
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(24) * 100;
}

/**
 * Fresh pool state plus its daily realized volatility (last 24h) and market
 * regime (last 72h). Either is null when candles are unusable.
 */
export async function poolWithVolatility(address) {
  const [pool, candles] = await Promise.all([getPool(address), ohlcv(address, { hours: 73 })]);
  return { ...pool, daily_vol_pct: realizedVolatility(candles.slice(-25)), regime: classifyRegime(candles, candles.length - 1, config.strategy.regimeThresholds) };
}
