// Deterministic exit and sizing rules for the standalone runtime.

import { config } from "./config.js";
import { log } from "./logger.js";
import { getTrackedPosition } from "./state.js";

/**
 * Rule-based close decision for a position (stop loss, take profit, range
 * exhaustion, low yield). Returns { action: "CLOSE", rule, reason } or null.
 */
export function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  // The tier recorded at entry may tighten the stop; the global value is the fallback.
  const stopLossPct = tracked && "stop_loss_pct" in tracked ? tracked.stop_loss_pct : config.screening.tiers[tracked?.tier]?.stopLossPct ?? managementConfig.stopLossPct;
  if (!pnlSuspect && position.pnl_pct != null && stopLossPct != null && position.pnl_pct <= stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  // takeProfitPct null = off: long farming lets fees accrue instead of capping upside.
  if (!pnlSuspect && position.pnl_pct != null && managementConfig.takeProfitPct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= (tracked?.oor_wait_minutes ?? managementConfig.outOfRangeWaitMinutes)
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

/**
 * Bins below the active bin so the range covers `rangeVolMult` × daily volatility
 * at this pool's bin step, clamped to the configured range (35-bin floor).
 * Throws on unknown inputs — never deploy a blind fixed range.
 */
export function computeBinsBelow(dailyVolPct, binStep, rangeVolMult = 2) {
  const vol = Number(dailyVolPct), step = Number(binStep), mult = Number(rangeVolMult);
  if (!Number.isFinite(vol) || vol <= 0) throw new Error(`Invalid volatility ${dailyVolPct ?? "unknown"} — refusing volatility-scaled deploy.`);
  if (!Number.isFinite(step) || step <= 0) throw new Error(`Invalid bin step ${binStep ?? "unknown"} — refusing deploy.`);
  if (!Number.isFinite(mult) || mult <= 0) throw new Error(`Invalid rangeVolMult ${rangeVolMult}`);
  const targetPct = Math.min(95, mult * vol); // a downside range cannot exceed -100%
  const bins = Math.ceil(-Math.log(1 - targetPct / 100) / Math.log(1 + step / 10_000));
  return Math.max(config.strategy.minBinsBelow, Math.min(config.strategy.maxBinsBelow, bins));
}
