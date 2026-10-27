// Market regime from hourly candles (data up to index i only): trend over 72h /
// 24h and realized daily volatility. Shared by the runtime (shape choice) and
// the research scripts, so backtests and live entries classify identically.
import { realizedVolatility } from './meteora.js';

export const REGIME_DEFAULTS = { trendPct: 5, lowVol: 5, highVol: 12 };

export function classifyRegime(candles, i = candles.length - 1, { trendPct, lowVol, highVol } = REGIME_DEFAULTS) {
  if (!Array.isArray(candles) || i < 72 || !(candles[i]?.close > 0) || !(candles[i - 72]?.close > 0)) return null;
  const trend72 = (candles[i].close / candles[i - 72].close - 1) * 100;
  const trend24 = (candles[i].close / candles[i - 24].close - 1) * 100;
  const vol24 = realizedVolatility(candles.slice(i - 24, i + 1));
  if (!(vol24 > 0)) return null;
  const trend = trend72 > trendPct && trend24 > 0 ? 'up' : trend72 < -trendPct && trend24 < 0 ? 'down' : 'range';
  const vol = vol24 < lowVol ? 'low' : vol24 > highVol ? 'high' : 'mid';
  return { key: `${trend}/${vol}`, trend, vol, trend72, trend24, vol24 };
}

// An entry is a shape name, "skip", or a tuned object { shape, rangeVolMult?, stopLossPct?, outOfRangeWaitMinutes? }.
function resolveEntry(entry, why) {
  if (typeof entry === 'string') return { shape: entry, why, overrides: {} };
  const { shape, rangeVolMult, stopLossPct, outOfRangeWaitMinutes } = entry;
  const overrides = Object.fromEntries(Object.entries({ rangeVolMult, stopLossPct, outOfRangeWaitMinutes }).filter(([, v]) => v !== undefined));
  return { shape, why, overrides };
}

/**
 * Liquidity shape for an entry. Fixed strategies pass through. Under "auto" the
 * coin's label (coin-labels.json) selects its group strategy:
 *   "regime" (or { regimes: {...} }) — look the pool regime up in that map,
 *     falling back to the global regimeStrategies, then regimeFallback;
 *   a shape / "skip" / tuned entry — use it whatever the regime.
 * Unlabeled coins use `unlabeledStrategy` (default "regime").
 */
export function pickShape(regime, s, label = null) {
  if (s.strategy !== 'auto') return { shape: s.strategy, why: 'fixed', overrides: {} };
  const group = label ? s.labelStrategies?.[label] ?? 'regime' : s.unlabeledStrategy ?? 'regime';
  const who = label ? `label ${label}` : 'unlabeled';
  if (group !== 'regime' && !group?.regimes) return resolveEntry(group, who);
  if (!regime) return resolveEntry(s.regimeFallback, `${who}, regime unknown`);
  const entry = group.regimes?.[regime.key] ?? s.regimeStrategies[regime.key] ?? s.regimeFallback;
  return resolveEntry(entry, `${who}, regime ${regime.key}`);
}
