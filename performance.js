// Local closed-position accounting in the SQLite performance table (db.js).
import { log } from "./logger.js";
import { getDb, getDoc, putDoc, listDocs } from "./db.js";
const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "entry_mcap",
  "entry_tvl",
  "entry_volume",
];

function buildSignalSnapshot(perf) {
  const snapshot = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) snapshot.base_mint = perf.base_mint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

// Additive: signal source, tier and Jev answers stored on the entry attempt, for outcome correlation.
function lookupAttempt(mint) {
  if (!mint) return {};
  try {
    const attempt = getDoc("attempts", mint);
    if (!attempt) return {};
    return {
      ...(attempt.source ? { signal_source: attempt.source } : {}),
      ...(attempt.tier ? { tier: attempt.tier } : {}),
      ...(attempt.regime ? { regime: attempt.regime } : {}),
      ...(attempt.label ? { label: attempt.label } : {}),
      ...(attempt.indicators ? { indicators: attempt.indicators } : {}),
      ...(attempt.jev ? { jev: { decision: attempt.jev.decision, ...attempt.jev.answers } } : {}),
    };
  } catch { return {}; }
}

export async function recordPerformance(perf) {
  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const signalSnapshot = buildSignalSnapshot(perf);
  const entry = {
    ...lookupAttempt(perf.base_mint),
    ...perf,
    signal_snapshot: signalSnapshot,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  putDoc("performance", null, entry);

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
      entry_mcap: perf.entry_mcap,
      entry_tvl: perf.entry_tvl,
      entry_volume: perf.entry_volume,
      exit_mcap: perf.exit_mcap,
      exit_tvl: perf.exit_tvl,
      exit_volume: perf.exit_volume,
    });
  }

}

export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = listDocs("performance", "WHERE recorded_at >= ? ORDER BY id DESC LIMIT ?", cutoff, limit).reverse();

  if (rows.length === 0) return { positions: [], count: 0, hours };

  const filtered = rows
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

export function getPerformanceSummary() {
  const p = listDocs("performance");

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
  };
}

const PNL_AGGREGATE = "COUNT(*) AS n, SUM(pnl_usd) AS pnl, AVG(pnl_pct) AS avg_pct, SUM(pnl_usd > 0) AS wins";
const aggregate = (row) => ({
  count: row.n,
  total_pnl_usd: Math.round((row.pnl ?? 0) * 100) / 100,
  avg_pnl_pct: row.avg_pct == null ? null : Math.round(row.avg_pct * 100) / 100,
  win_rate_pct: row.n > 0 ? Math.round((row.wins / row.n) * 100) : null,
});

/** Closed-position PnL over the window, overall and grouped by tier, label and close reason. */
export function getPerformanceBreakdown({ hours = 168 } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const groupBy = (col) => db
    .prepare(`SELECT COALESCE(${col}, 'unknown') AS key, ${PNL_AGGREGATE} FROM performance WHERE recorded_at >= ? GROUP BY key ORDER BY pnl DESC`)
    .all(cutoff)
    .map((row) => ({ key: row.key, ...aggregate(row) }));
  return {
    hours,
    ...aggregate(db.prepare(`SELECT ${PNL_AGGREGATE} FROM performance WHERE recorded_at >= ?`).get(cutoff)),
    by_tier: groupBy("tier"),
    by_label: groupBy("label"),
    by_close_reason: groupBy("close_reason"),
    recent: listDocs("performance", "ORDER BY id DESC LIMIT 5").map((r) => ({
      pool_name: r.pool_name ?? r.pool,
      tier: r.tier ?? null,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      close_reason: r.close_reason ?? null,
      closed_at: r.recorded_at,
    })),
  };
}
