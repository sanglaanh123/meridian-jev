/**
 * Dev (deployer) blocklist — deployer wallet addresses that should never be deployed into.
 *
 * Agent/user can add deployers via Telegram ("block this deployer").
 * Screening hard-filters any pool whose base token was deployed by a blocked wallet
 * before focused screening can approve a token.
 */

import { log } from "./logger.js";
import { getDb } from "./db.js";

// Read errors propagate: an unreadable blocklist must fail closed.
const getEntry = (wallet) => getDb().prepare("SELECT label, reason, added_at FROM dev_blocklist WHERE wallet = ?").get(wallet);

export function isDevBlocked(devWallet) {
  if (!devWallet) return false;
  return !!getEntry(devWallet);
}

export function getBlockedDevs() {
  return Object.fromEntries(getDb().prepare("SELECT wallet, label, reason, added_at FROM dev_blocklist").all()
    .map(({ wallet, ...info }) => [wallet, info]));
}

export function blockDev({ wallet, reason, label }) {
  if (!wallet) return { error: "wallet required" };
  const existing = getEntry(wallet);
  if (existing) return { already_blocked: true, wallet, label: existing.label, reason: existing.reason };
  getDb().prepare("INSERT INTO dev_blocklist (wallet, label, reason, added_at) VALUES (?, ?, ?, ?)")
    .run(wallet, label || "unknown", reason || "no reason provided", new Date().toISOString());
  log("dev_blocklist", `Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export function unblockDev({ wallet }) {
  if (!wallet) return { error: "wallet required" };
  const entry = getEntry(wallet);
  if (!entry) return { error: `Wallet ${wallet} not on dev blocklist` };
  getDb().prepare("DELETE FROM dev_blocklist WHERE wallet = ?").run(wallet);
  log("dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export function listBlockedDevs() {
  const entries = Object.entries(getBlockedDevs()).map(([wallet, info]) => ({ wallet, ...info }));
  return { count: entries.length, blocked_devs: entries };
}
