/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Focused screening rejects blacklisted tokens before entry.
 */

import { log } from "./logger.js";
import { getDb } from "./db.js";

// Read errors propagate: an unreadable blacklist must fail closed.
const getEntry = (mint) => getDb().prepare("SELECT symbol, reason, added_at, added_by FROM token_blacklist WHERE mint = ?").get(mint);

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist.
 * Used by standalone/screening.js before entry.
 */
export function isBlacklisted(mint) {
  if (!mint) return false;
  return !!getEntry(mint);
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({ mint, symbol, reason }) {
  if (!mint) return { error: "mint required" };

  const existing = getEntry(mint);

  if (existing) {
    return {
      already_blacklisted: true,
      mint,
      symbol: existing.symbol,
      reason: existing.reason,
    };
  }

  getDb().prepare("INSERT INTO token_blacklist (mint, symbol, reason, added_at, added_by) VALUES (?, ?, ?, ?, ?)")
    .run(mint, symbol || "UNKNOWN", reason || "no reason provided", new Date().toISOString(), "agent");
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };

  const entry = getEntry(mint);

  if (!entry) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  getDb().prepare("DELETE FROM token_blacklist WHERE mint = ?").run(mint);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist() {
  const entries = getDb().prepare("SELECT mint, symbol, reason, added_at, added_by FROM token_blacklist ORDER BY added_at").all()
    .map((row) => ({ ...row }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}
