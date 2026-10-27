// Trend/range indicators ported from the user's MTA-HedgeB (efficiency-ratio
// "sideway" metrics, hedgeb/rotation.py) and M-EMA-Bot (ER regime, SMC
// BOS/CHoCH structure, ATR ZLEMA, backend/app/strategy). Pure functions over
// closed candles { open, high, low, close }; values at bar i use bars ≤ i only.

const pct = (a, b) => (a - b) / b * 100;

/**
 * Window shape over the `window` bars ending at i (MTA sideway_metrics +
 * scalpability_metrics). er ≈ 0 = chop, ≈ 1 = one clean directional move.
 */
export function erMetrics(candles, i, window) {
  const from = i - window + 1;
  if (from < 0 || !(candles[from]?.close > 0)) return null;
  const w = candles.slice(from, i + 1);
  const ref = w[0].close;
  let path = 0, up = 0, down = 0, biggest = 0;
  for (let k = 1; k < w.length; k++) {
    const d = w[k].close - w[k - 1].close;
    path += Math.abs(d);
    if (d > 0) up += d; else down -= d;
    biggest = Math.max(biggest, Math.abs(d));
  }
  const driftPct = pct(w.at(-1).close, ref);
  const pathPct = path / ref * 100;
  const hi = Math.max(...w.map(c => c.high)), lo = Math.min(...w.map(c => c.low));
  return {
    er: pathPct > 1e-12 ? Math.abs(driftPct) / pathPct : 1,
    driftPct, pathPct,
    rangePct: (hi - lo) / ref * 100,
    position: hi > lo ? (w.at(-1).close - lo) / (hi - lo) : 0.5,
    directionBalance: Math.max(up, down) > 0 ? Math.min(up, down) / Math.max(up, down) : 0,
    singleBarShare: path > 0 ? biggest / path : 0,
  };
}

/** M-EMA-Bot regime.classify: trend needs ER ≥ erTrend and |drift| ≥ driftPct. */
export function classifyEr(m, { erTrend = 0.35, driftPct = 1 } = {}) {
  if (!m) return null;
  if (m.er < erTrend || Math.abs(m.driftPct) < driftPct) return 'chop';
  return m.driftPct > 0 ? 'bull' : 'bear';
}

/** Wilder true-range average per bar (null until `period` bars exist). */
export function atrSeries(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  let atr = null, sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const tr = prev ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)) : c.high - c.low;
    if (i < period) { sum += tr; if (i === period - 1) atr = sum / period; }
    else atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

export const atrPct = (candles, i, period = 14) => {
  const a = atrSeries(candles.slice(0, i + 1), period)[i];
  return a == null ? null : a / candles[i].close * 100;
};

/** Median size (%) of zigzag swings ≥ thresholdPct over the window (MTA zigzag_swings). */
export function zigzagSwingPct(candles, i, window, thresholdPct) {
  const from = i - window + 1;
  if (from < 0) return null;
  const swings = [];
  let pivot = candles[from].close, dir = 0;
  let extreme = pivot;
  for (let k = from + 1; k <= i; k++) {
    const p = candles[k].close;
    if (dir >= 0 && p > extreme) extreme = p;
    if (dir <= 0 && p < extreme) extreme = p;
    const move = pct(p, extreme);
    if (dir >= 0 && move <= -thresholdPct && extreme !== pivot) { swings.push(Math.abs(pct(extreme, pivot))); pivot = extreme; extreme = p; dir = -1; }
    else if (dir <= 0 && move >= thresholdPct && extreme !== pivot) { swings.push(Math.abs(pct(extreme, pivot))); pivot = extreme; extreme = p; dir = 1; }
    else if (dir === 0) dir = move >= 0 ? 1 : -1;
  }
  if (!swings.length) return null;
  const s = swings.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * SMC market structure (M-EMA-Bot smc/structure.py): fractal swings with
 * `swingN` bars each side, confirmed only after the right bars close; a close
 * beyond the active swing is a BOS (with trend) or CHoCH (against it).
 * Returns per-bar { trend: 1 | -1 | 0, event: null | 'BOS+' | 'BOS-' | 'CHOCH+' | 'CHOCH-' }.
 */
export function structureSeries(candles, swingN = 3) {
  const out = [];
  let trend = 0, activeHigh = null, activeLow = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let event = null;
    if (activeHigh != null && c.close > activeHigh) { event = trend === 1 ? 'BOS+' : 'CHOCH+'; trend = 1; activeHigh = null; }
    if (activeLow != null && c.close < activeLow) { const e = trend === -1 ? 'BOS-' : 'CHOCH-'; event ??= e; trend = -1; activeLow = null; }
    const mid = i - swingN;
    if (mid - swingN >= 0) {
      const m = candles[mid];
      let isHigh = true, isLow = true;
      for (let k = mid - swingN; k <= mid + swingN; k++) {
        if (k === mid) continue;
        if (!(m.high > candles[k].high)) isHigh = false;
        if (!(m.low < candles[k].low)) isLow = false;
      }
      if (isHigh) activeHigh = m.high;
      if (isLow) activeLow = m.low;
    }
    out.push({ trend, event });
  }
  return out;
}

/** QuantAlgo ATR ZLEMA (M-EMA-Bot indicators.py): Supertrend-like trend ±1 per bar (null in warm-up). */
export function atrZlemaTrend(candles, { len = 7, atrLen = 7, mult = 2.0, noise = 0.15 } = {}) {
  const out = Array(candles.length).fill(null);
  const lag = Math.floor((len - 1) / 2), alpha = 2 / (len + 1);
  const atrs = atrSeries(candles, atrLen);
  let raw = null, zlema = null, trailing = null, trend = 1;
  for (let i = 0; i < candles.length; i++) {
    const atr = atrs[i];
    if (i >= lag) {
      const corrected = candles[i].close + (candles[i].close - candles[i - lag].close);
      raw = raw == null ? corrected : (corrected - raw) * alpha + raw;
      if (zlema == null) zlema = raw;
      else if (atr != null && Math.abs(raw - zlema) > atr * noise) zlema = raw;
    }
    if (atr == null || zlema == null) continue;
    const band = atr * mult;
    if (trailing == null) trailing = zlema - band;
    if (trend === 1) {
      if (zlema < trailing) { trend = -1; trailing = zlema + band; } else trailing = Math.max(trailing, zlema - band);
    } else if (zlema > trailing) { trend = 1; trailing = zlema - band; } else trailing = Math.min(trailing, zlema + band);
    out[i] = trend;
  }
  return out;
}

/** Wilder ADX per bar (null in warm-up, ~2·period bars). */
export function adxSeries(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  let trS = 0, pS = 0, mS = 0, adx = null, dxSum = 0, dxN = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const upMove = c.high - p.high, downMove = p.low - c.low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= period) { trS += tr; pS += plusDM; mS += minusDM; if (i < period) continue; }
    else { trS = trS - trS / period + tr; pS = pS - pS / period + plusDM; mS = mS - mS / period + minusDM; }
    const pDI = trS > 0 ? 100 * pS / trS : 0, mDI = trS > 0 ? 100 * mS / trS : 0;
    const dx = pDI + mDI > 0 ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 0;
    if (adx == null) { dxSum += dx; dxN++; if (dxN === period) adx = dxSum / period; }
    else adx = (adx * (period - 1) + dx) / period;
    out[i] = adx;
  }
  return out;
}

/**
 * Closed `hours`-hour bars built from hourly candles (UTC-aligned on timestamp).
 * Returns { bars, closeIndex } where closeIndex[k] = hourly index at which bar k is complete.
 */
export function resample(candles, hours) {
  const bars = [], closeIndex = [];
  let cur = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const bucket = Math.floor(c.timestamp / (hours * 3600));
    if (!cur || cur.bucket !== bucket) {
      if (cur && cur.n === hours) { bars.push(cur.bar); closeIndex.push(i - 1); }
      cur = { bucket, n: 0, bar: { timestamp: bucket * hours * 3600, open: c.open, high: c.high, low: c.low, close: c.close } };
    }
    cur.n++;
    cur.bar.high = Math.max(cur.bar.high, c.high);
    cur.bar.low = Math.min(cur.bar.low, c.low);
    cur.bar.close = c.close;
  }
  if (cur && cur.n === hours) { bars.push(cur.bar); closeIndex.push(candles.length - 1); }
  return { bars, closeIndex };
}

// ─── Gates and exits shared by the bot and scripts/indicator-lab.js ─────────
// A snapshot holds the latest closed-bar values; 4h values come from 4h bars.

/** Feature snapshot from hourly and 4h candles (both closed bars only, oldest first). */
export function indicatorSnapshot(c1h, c4h) {
  const i = c1h.length - 1, k = c4h.length - 1;
  const er4 = k >= 5 ? erMetrics(c4h, k, 6) : null;
  return {
    er1: i >= 23 ? erMetrics(c1h, i, 24) : null,
    er4, regime4: classifyEr(er4),
    struct4: k >= 0 ? structureSeries(c4h, 3)[k].trend : 0,
    zl4: k >= 0 ? atrZlemaTrend(c4h)[k] : null,
    zl1: i >= 0 ? atrZlemaTrend(c1h)[i] : null,
    adx1: i >= 0 ? adxSeries(c1h)[i] : null,
  };
}

// Entry gates: true = entry allowed. Chosen per label group by scripts/indicator-lab.js.
export const INDICATOR_GATES = {
  none: () => true,
  er4_chop: f => f.regime4 === 'chop',
  not_bear4: f => f.regime4 !== 'bear',
  er1_low: f => f.er1 != null && f.er1.er < 0.3,
  struct4_not_down: f => f.struct4 !== -1,
  zl4_up: f => f.zl4 === 1,
  zl1_up: f => f.zl1 === 1,
  adx1_low: f => f.adx1 != null && f.adx1 < 20,
  not_bear4_and_struct: f => f.regime4 !== 'bear' && f.struct4 !== -1,
  er4_chop_and_struct: f => f.regime4 === 'chop' && f.struct4 !== -1,
};
// Exit triggers: true = withdraw now.
export const INDICATOR_EXITS = {
  none: () => false,
  bear4: f => f.regime4 === 'bear',
  struct4_down: f => f.struct4 === -1,
  zl4_down: f => f.zl4 === -1,
  zl1_down: f => f.zl1 === -1,
  bear4_or_struct: f => f.regime4 === 'bear' || f.struct4 === -1,
};

/** Drop a still-forming last candle (its period has not ended yet). */
export const closedOnly = (candles, hours, nowSec = Date.now() / 1000) =>
  candles.length && candles.at(-1).timestamp + hours * 3600 > nowSec ? candles.slice(0, -1) : candles;
