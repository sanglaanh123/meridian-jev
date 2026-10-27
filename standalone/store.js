import { getDb, putDoc, getKv, setKv, tx } from '../db.js';

const byKey = table => Object.fromEntries(getDb().prepare(`SELECT mint, data FROM ${table}`).all().map(r => [r.mint, JSON.parse(r.data)]));

// Signals and attempts live in SQLite (db.js). `data` stays the in-memory working
// copy: callers mutate it directly and call save(), which rewrites both tables atomically.
export class MonitorStore {
  constructor() {
    this.data = { ...(getKv('monitor_extras') ?? {}), version: 1, signals: byKey('signals'), attempts: byKey('attempts') };
  }
  save() {
    const { version, signals, attempts, ...extras } = this.data;
    tx(db => {
      db.exec('DELETE FROM signals; DELETE FROM attempts;');
      for (const [mint, s] of Object.entries(signals)) putDoc('signals', mint, s);
      for (const [mint, a] of Object.entries(attempts)) putDoc('attempts', mint, a);
      setKv('monitor_extras', extras);
    });
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
