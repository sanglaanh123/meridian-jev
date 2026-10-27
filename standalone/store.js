import fs from 'node:fs';
import { repoPath } from '../repo-root.js';

// Keys left over from the retired smart-wallet monitor; dropped on load.
const LEGACY_KEYS = ['wallets', 'pending', 'seen', 'events'];

export class MonitorStore {
  constructor(file = repoPath('wallet-monitor-state.json')) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, signals: {}, attempts: {} };
    if (this.data.version !== 1 || !this.data.attempts || typeof this.data.attempts !== 'object') throw new Error('Invalid monitor state; refusing to discard recovery history');
    this.data.signals ??= {};
    for (const key of LEGACY_KEYS) delete this.data[key];
  }
  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  prune(now = Date.now()) {
    for (const [mint, s] of Object.entries(this.data.signals)) if (s.done && now - s.createdAt > 24 * 3600_000 && !(now < s.cooldownUntil)) delete this.data.signals[mint];
    // Attempt records double as mint-level duplicate protection; a day matches
    // the pool-memory cooldown horizon. Never prune mid-submit checkpoints.
    for (const [mint, a] of Object.entries(this.data.attempts)) if (a.status !== "submitting" && now - a.at > 24 * 3600_000) delete this.data.attempts[mint];
  }
}
/** True while a mint has an open signal or one still cooling down. */
export function signalBlocked(store, mint, now = Date.now()) {
  const existing = store.data.signals[mint];
  return !!existing && (!existing.done || now < existing.cooldownUntil);
}
/** Record a scanner candidate as an entry signal unless the mint is already busy. */
export function acceptPoolSignal(store, candidate, options, now = Date.now()) {
  if (signalBlocked(store, candidate.mint, now)) return null;
  const signal = {
    mint: candidate.mint, source: 'meteora', pool: candidate.pool, tier: candidate.tier,
    reasons: candidate.reasons ?? [], metrics: candidate.metrics ?? {},
    createdAt: now, deadline: now + options.screeningDeadlineSec * 1000, done: false,
  };
  store.data.signals[candidate.mint] = signal;
  store.prune(now);
  store.save();
  return signal;
}
export function finishSignal(store, signal, reason, options, now = Date.now()) {
  Object.assign(signal, { done: true, reason, closedAt: now, cooldownUntil: now + options.cooldownSec * 1000 });
  store.save();
}
// Signals still open at startup were orphaned by a restart/crash; close them so
// their mints can trigger again after the cooldown. Attempt records still guard duplicates.
export function finishStaleSignals(store, options, now = Date.now()) {
  let n = 0;
  for (const signal of Object.values(store.data.signals)) {
    if (signal.done) continue;
    Object.assign(signal, { done: true, reason: 'interrupted by restart', closedAt: now, cooldownUntil: now + options.cooldownSec * 1000 });
    n++;
  }
  if (n) store.save();
  return n;
}
