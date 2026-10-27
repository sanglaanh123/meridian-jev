// Pure hourly simulator for DLMM positions on one pool, used by the backtest and
// the strategy lab. Model (deliberately simple — read before trusting numbers):
// - A position is a ladder of bins around the entry price. Bins at/below entry
//   start as SOL and convert to token at their own price when price trades below
//   them; bins above entry start as token (bought at entry) and convert to SOL
//   when price trades above them. Value therefore depends only on price.
// - Shapes set the per-bin weight: spot = flat, curve = concentrated at the
//   entry price, bidask = concentrated at the edges.
// - LP fees for an hour = position value × (pool LP fees / today's pool TVL)
//   × `concentration` × our relative liquidity density where the hour traded
//   (1 = a flat position, 0 = out of range). TVL history is unavailable.
// - Exit rules mirror exit-rules.js / state.js. Swaps (entry token side, close
//   token side) cost `swapFeePct`; `txCostPct` is charged per round trip.
import { realizedVolatility } from "../standalone/meteora.js";
import { computeBinsBelow } from "../exit-rules.js";
export { classifyRegime } from "../standalone/regime.js";

export const STRATEGIES = [
  { id: "bid_spot", side: "below", shape: "spot" },     // the bot today
  { id: "bid_curve", side: "below", shape: "curve" },
  { id: "bid_bidask", side: "below", shape: "bidask" },
  { id: "two_spot", side: "two", shape: "spot" },
  { id: "two_curve", side: "two", shape: "curve" },
  { id: "two_bidask", side: "two", shape: "bidask" },
];

/** Bins needed so the ladder spans `pct` percent downward at this bin step. */
export const binsForMove = (pct, binStep) => Math.ceil(-Math.log(1 - Math.min(95, pct) / 100) / Math.log(1 + binStep / 10_000));

function shapeWeight(shape, d, span) {
  if (shape === "curve") return Math.exp(-((d / Math.max(1, span / 3)) ** 2));
  if (shape === "bidask") return 0.25 + d / Math.max(1, span);
  return 1;
}

/** Build a position worth 1 SOL at entry. side: "below" (SOL only) or "two" (SOL below, token above). */
export function buildPosition({ entryPrice, binStep, side = "below", shape = "spot", binsBelow, binsAbove = 0 }) {
  const r = 1 + binStep / 10_000;
  const ks = [];
  for (let k = -(binsBelow - 1); k <= (side === "two" ? binsAbove : 0); k++) ks.push(k);
  const span = side === "two" ? Math.max(binsBelow - 1, binsAbove) : binsBelow - 1;
  const raw = ks.map(k => shapeWeight(shape, Math.abs(k), span));
  const total = raw.reduce((a, b) => a + b, 0);
  const bins = ks.map((k, j) => ({ k, price: entryPrice * r ** k, w: raw[j] / total, token: k > 0 }));
  return {
    entryPrice, r, bins, n: bins.length,
    hi: bins.at(-1).price, lo: bins[0].price,
    tokenWeight: bins.filter(b => b.token).reduce((a, b) => a + b.w, 0),
  };
}

/** Value (SOL) and token-side value at price p, before swap costs. */
export function valueAt(pos, p) {
  let value = 0, tokenValue = 0;
  for (const b of pos.bins) {
    if (!b.token) {
      if (p < b.price) { const v = b.w * p / b.price; value += v; tokenValue += v; } else value += b.w;
    } else {
      const units = b.w / pos.entryPrice;
      if (p > b.price) value += units * b.price; else { const v = units * p; value += v; tokenValue += v; }
    }
  }
  return { value, tokenValue };
}

/** Our liquidity density at price p relative to a flat position of the same width (0 outside). */
function density(pos, p) {
  const k = Math.round(Math.log(p / pos.entryPrice) / Math.log(pos.r));
  const b = pos.bins[k - pos.bins[0].k]; // bins are contiguous in k
  return b ? b.w * pos.n : 0;
}

/** Average density over the hour's traded range (16 log-spaced samples). */
export function feeShare(pos, low, high) {
  if (!(high > low)) return density(pos, low);
  let sum = 0;
  for (let s = 0; s < 16; s++) sum += density(pos, low * (high / low) ** ((s + 0.5) / 16));
  return sum / 16;
}

// Back-compat helpers for a flat SOL-only ladder (used by tests).
export const binPrices = (entryPrice, bins, binStep) => buildPosition({ entryPrice, binStep, binsBelow: bins }).bins.map(b => b.price).reverse();
export function positionValue(prices, p) {
  const binStep = prices.length > 1 ? (prices[0] / prices[1] - 1) * 10_000 : 1;
  return valueAt(buildPosition({ entryPrice: prices[0], binStep, binsBelow: prices.length }), p);
}

/** Entry gate on data up to and including hour i (no look-ahead). */
export function qualifies(i, candles, lpFees, tvl, tier, s, trend = {}) {
  if (i < 24 || !(tvl > 0)) return { ok: false, reason: "warmup" };
  // Optional trend gate (research only, not in the bot yet): skip falling tokens.
  if (trend.minTrend24hPct != null && (candles[i].close / candles[i - 24].close - 1) * 100 < trend.minTrend24hPct) return { ok: false, reason: "trend" };
  const fee24 = lpFees.slice(i - 23, i + 1).reduce((a, b) => a + b, 0);
  const fee4 = lpFees.slice(i - 3, i + 1).reduce((a, b) => a + b, 0);
  const ratio24 = fee24 / tvl * 100;
  if (ratio24 < tier.minFeeTvl24hPct) return { ok: false, reason: "fee" };
  const stability = fee24 > 0 ? (fee4 * 6) / fee24 : null;
  if (stability == null || stability < s.feeStabilityMin || stability > s.feeStabilityMax) return { ok: false, reason: "stability" };
  const vol = realizedVolatility(candles.slice(i - 24, i + 1));
  if (!(vol > 0) || vol > tier.maxDailyVolPct) return { ok: false, reason: "volatility" };
  return { ok: true, vol, ratio24 };
}

/** Open a position of `strategy` at hour i's close sized from daily volatility. */
export function openPosition(strategy, entryPrice, vol, binStep, rangeVolMult) {
  if (strategy.side === "two") {
    const side = Math.max(17, Math.min(34, binsForMove(rangeVolMult * vol, binStep)));
    return buildPosition({ entryPrice, binStep, side: "two", shape: strategy.shape, binsBelow: side + 1, binsAbove: side });
  }
  return buildPosition({ entryPrice, binStep, side: "below", shape: strategy.shape, binsBelow: computeBinsBelow(vol, binStep, rangeVolMult) });
}

/**
 * Advance an open position by hour i: accrue fees, then apply exit rules.
 * Returns the exit { price, reason } or null to keep holding.
 */
export function stepHour(state, c, lpFee, tvl, params, binStep, concentration) {
  const { pos } = state;
  const { value } = valueAt(pos, c.close);
  const fee = value * (lpFee / tvl) * concentration * feeShare(pos, c.low, c.high);
  state.fees += fee;
  state.feeLog.push(fee);
  const pnlAt = p => (valueAt(pos, p).value + state.fees - 1) * 100;
  if (params.stopLossPct != null && pnlAt(c.low) <= params.stopLossPct) return { price: c.low, reason: "stop loss" };
  if (params.takeProfitPct != null && pnlAt(c.high) >= params.takeProfitPct) return { price: c.high, reason: "take profit" };
  if (c.close > pos.hi * (1 + binStep / 10_000) ** params.outOfRangeBinsToClose) return { price: c.close, reason: "pumped far above range" };
  state.oorHours = c.close > pos.hi || c.close < pos.lo ? state.oorHours + 1 : 0;
  // Below the range the position is 100% token; an optional shorter wait limits that exposure.
  const wait = c.close < pos.lo && params.belowRangeWaitMinutes != null ? params.belowRangeWaitMinutes : params.outOfRangeWaitMinutes;
  if (state.oorHours * 60 >= wait) return { price: c.close, reason: c.close < pos.lo ? "OOR below" : "OOR" };
  if (params.minFeePerTvl24h != null && state.age * 60 >= params.minAgeBeforeYieldCheck && state.feeLog.length >= 24) {
    const yield24 = state.feeLog.slice(-24).reduce((a, b) => a + b, 0) / value * 100;
    if (yield24 < params.minFeePerTvl24h) return { price: c.close, reason: "low yield" };
  }
  return null;
}

/** Net SOL multiple of a closed position, after entry/exit swaps and tx costs. */
export function settle(state, price, costs) {
  const { value, tokenValue } = valueAt(state.pos, price);
  return value - tokenValue * costs.swapFeePct / 100 - state.pos.tokenWeight * costs.swapFeePct / 100 + state.fees - costs.txCostPct / 100;
}

/** One position opened at hour i0, held until an exit rule fires or `horizonHours`. */
export function simulateEpisode({ candles, lpFees, tvl, binStep, i0, strategy, vol, params, costs, concentration = 1, horizonHours = 72, exitAt = null }) {
  const state = { pos: openPosition(strategy, candles[i0].close, vol, binStep, params.rangeVolMult), fees: 0, feeLog: [], oorHours: 0, age: 0 };
  const end = Math.min(candles.length - 1, i0 + horizonHours);
  for (let i = i0 + 1; i <= end; i++) {
    state.age = i - i0;
    // Optional indicator exit (research): checked after the hour's fees and rules, closes at the hour's close.
    const exit = stepHour(state, candles[i], lpFees[i], tvl, params, binStep, concentration) ?? (exitAt?.(i) ? { price: candles[i].close, reason: "indicator" } : null);
    if (exit) return { pnlPct: (settle(state, exit.price, costs) - 1) * 100, feesPct: state.fees * 100, hours: i - i0, reason: exit.reason };
  }
  return { pnlPct: (settle(state, candles[end].close, costs) - 1) * 100, feesPct: state.fees * 100, hours: end - i0, reason: "horizon" };
}

/**
 * Simulate the bot's loop on one pool: gate → open → hold → close → cooldown.
 * `params`: rangeVolMult, stopLossPct (null=off), takeProfitPct (null=off),
 * outOfRangeWaitMinutes, outOfRangeBinsToClose, minFeePerTvl24h,
 * minAgeBeforeYieldCheck, cooldownHours, [minTrend24hPct, belowRangeWaitMinutes, strategy].
 */
export function simulatePool({ candles, lpFees, tvl, binStep, tier, screening, params, costs, concentration = 1 }) {
  const strategy = params.strategy ?? STRATEGIES[0];
  const trades = [];
  let state = null, equity = 1, peak = 1, maxDrawdown = 0, cooldownUntil = -1, hoursIn = 0;
  const close = (i, price, reason) => {
    const net = settle(state, price, costs);
    trades.push({ entry: state.entry, exit: i, hours: i - state.entry, pnlPct: (net - 1) * 100, feesPct: state.fees * 100, reason });
    equity *= net;
    state = null;
    cooldownUntil = i + params.cooldownHours;
  };
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!state) {
      if (i < cooldownUntil) continue;
      const q = qualifies(i, candles, lpFees, tvl, tier, screening, params);
      if (!q.ok) continue;
      state = { entry: i, pos: openPosition(strategy, c.close, q.vol, binStep, params.rangeVolMult), fees: 0, feeLog: [], oorHours: 0, age: 0 };
      continue; // entered at this hour's close; fees start next hour
    }
    hoursIn++;
    state.age = i - state.entry;
    const exit = stepHour(state, c, lpFees[i], tvl, params, binStep, concentration);
    // Mark-to-market drawdown on the compounded equity.
    const mark = equity * (valueAt(state.pos, c.close).value + state.fees);
    peak = Math.max(peak, mark);
    maxDrawdown = Math.max(maxDrawdown, (peak - mark) / peak * 100);
    if (exit) close(i, exit.price, exit.reason);
  }
  if (state) close(candles.length - 1, candles.at(-1).close, "end of data");
  const hours = Math.max(1, candles.length - 24);
  return {
    trades, returnPct: (equity - 1) * 100, monthlyPct: (equity ** (720 / hours) - 1) * 100,
    maxDrawdownPct: maxDrawdown, exposurePct: hoursIn / hours * 100,
    stops: trades.filter(t => t.reason === "stop loss").length,
  };
}
