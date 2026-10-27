// SQLite store for all local state (node:sqlite, synchronous). Owns the connection,
// the schema, row mapping for document tables, and the one-time import of the
// legacy JSON files. Nothing is opened on import.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

export const dbPath = () => process.env.MERIDIAN_DB || repoPath("meridian.db");

const MIGRATIONS = [
  `CREATE TABLE positions (address TEXT PRIMARY KEY, pool TEXT, pool_name TEXT, tier TEXT, label TEXT, closed INTEGER NOT NULL DEFAULT 0, deployed_at TEXT, closed_at TEXT, data TEXT NOT NULL);
   CREATE INDEX positions_closed ON positions(closed);
   CREATE INDEX positions_pool ON positions(pool);
   CREATE TABLE position_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, action TEXT NOT NULL, position TEXT, pool_name TEXT, reason TEXT);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE performance (id INTEGER PRIMARY KEY, recorded_at TEXT, position TEXT, pool TEXT, base_mint TEXT, tier TEXT, label TEXT, close_reason TEXT, pnl_usd REAL, pnl_pct REAL, data TEXT NOT NULL);
   CREATE INDEX performance_recorded ON performance(recorded_at);
   CREATE TABLE pools (address TEXT PRIMARY KEY, base_mint TEXT, cooldown_until TEXT, base_mint_cooldown_until TEXT, data TEXT NOT NULL);
   CREATE INDEX pools_base_mint ON pools(base_mint);
   CREATE TABLE token_blacklist (mint TEXT PRIMARY KEY, symbol TEXT, reason TEXT, added_at TEXT, added_by TEXT);
   CREATE TABLE dev_blocklist (wallet TEXT PRIMARY KEY, label TEXT, reason TEXT, added_at TEXT);
   CREATE TABLE decisions (id TEXT PRIMARY KEY, ts TEXT, type TEXT, actor TEXT, pool TEXT, position TEXT, data TEXT NOT NULL);
   CREATE INDEX decisions_ts ON decisions(ts);
   CREATE TABLE signals (mint TEXT PRIMARY KEY, created_at INTEGER, done INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER, data TEXT NOT NULL);
   CREATE TABLE attempts (mint TEXT PRIMARY KEY, at INTEGER, status TEXT, data TEXT NOT NULL);`,
];

// Document tables keep the full record as JSON in `data`, plus indexed columns for queries.
const DOCS = {
  positions: { key: "address", cols: p => ({ pool: p.pool, pool_name: p.pool_name, tier: p.tier, label: p.label, closed: p.closed ? 1 : 0, deployed_at: p.deployed_at, closed_at: p.closed_at }) },
  pools: { key: "address", cols: e => ({ base_mint: e.base_mint, cooldown_until: e.cooldown_until, base_mint_cooldown_until: e.base_mint_cooldown_until }) },
  performance: { key: "id", cols: r => ({ recorded_at: r.recorded_at, position: r.position, pool: r.pool, base_mint: r.base_mint, tier: r.tier, label: r.label, close_reason: r.close_reason, pnl_usd: r.pnl_usd, pnl_pct: r.pnl_pct }) },
  decisions: { key: "id", cols: d => ({ ts: d.ts, type: d.type, actor: d.actor, pool: d.pool, position: d.position }) },
  signals: { key: "mint", cols: s => ({ created_at: s.createdAt, done: s.done ? 1 : 0, cooldown_until: s.cooldownUntil }) },
  attempts: { key: "mint", cols: a => ({ at: a.at, status: a.status }) },
};

// node:sqlite binds only null, numbers, bigints, strings and buffers.
const bindable = v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" && !Number.isFinite(v) ? null : v;

let db = null;

export function getDb() {
  if (db) return db;
  const file = dbPath();
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  const version = conn.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    conn.exec("BEGIN IMMEDIATE");
    try { conn.exec(MIGRATIONS[v]); conn.exec(`PRAGMA user_version = ${v + 1}`); conn.exec("COMMIT"); }
    catch (e) { conn.exec("ROLLBACK"); conn.close(); throw e; }
  }
  db = conn;
  try { importLegacyJson(path.dirname(file)); }
  catch (e) { db = null; conn.close(); throw e; }
  return db;
}

/** Read-only connection for ad-hoc queries; the engine rejects writes. */
export function openReadOnly() {
  getDb();
  return new DatabaseSync(dbPath(), { readOnly: true });
}

/** Run one SELECT/WITH statement on a read-only connection. */
export function readOnlyQuery(sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("Only SELECT or WITH queries are allowed");
  const ro = openReadOnly();
  try { return ro.prepare(sql).all().map(row => ({ ...row })); }
  finally { ro.close(); }
}

/** Close the shared connection (tests switch databases between cases). */
export function closeDb() {
  db?.close();
  db = null;
}

/** Run fn inside one write transaction; nested calls join the outer one. */
export function tx(fn) {
  const conn = getDb();
  if (conn.isTransaction) return fn(conn);
  conn.exec("BEGIN IMMEDIATE");
  try { const out = fn(conn); conn.exec("COMMIT"); return out; }
  catch (e) { conn.exec("ROLLBACK"); throw e; }
}

/** Insert or replace a document row; returns the key (new rowid for autoincrement tables). */
export function putDoc(table, key, record) {
  const { key: keyCol, cols } = DOCS[table];
  const extra = cols(record);
  const names = [...(key == null ? [] : [keyCol]), ...Object.keys(extra), "data"];
  const values = [...(key == null ? [] : [key]), ...Object.values(extra), JSON.stringify(record)].map(bindable);
  const updates = names.filter(n => n !== keyCol).map(n => `${n} = excluded.${n}`).join(", ");
  const res = getDb().prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT(${keyCol}) DO UPDATE SET ${updates}`).run(...values);
  return key ?? Number(res.lastInsertRowid);
}

export function getDoc(table, key) {
  const row = getDb().prepare(`SELECT data FROM ${table} WHERE ${DOCS[table].key} = ?`).get(key);
  return row ? JSON.parse(row.data) : null;
}

/** Documents matching an optional SQL tail (WHERE/ORDER/LIMIT), parsed. */
export function listDocs(table, tail = "", ...params) {
  return getDb().prepare(`SELECT data FROM ${table} ${tail}`).all(...params).map(r => JSON.parse(r.data));
}

export function getKv(key) {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

export function setKv(key, value) {
  getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value ?? null));
}

// ─── Legacy JSON import ─────────────────────────────────────────
// Each file is imported once from the database's own directory, then renamed to
// <file>.migrated. A file that reappears after its import is left alone with a warning.

const readJson = (file, onError) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return onError(e); }
};

const LEGACY = {
  "state.json": file => {
    const state = readJson(file, e => { throw new Error(`state.json is unreadable: ${e.message}`); });
    for (const [address, pos] of Object.entries(state.positions ?? {})) putDoc("positions", address, pos);
    const insert = db.prepare("INSERT INTO position_events (ts, action, position, pool_name, reason) VALUES (?, ?, ?, ?, ?)");
    for (const e of state.recentEvents ?? []) insert.run(...[e.ts, e.action, e.position, e.pool_name, e.reason].map(bindable));
    if (state._lastBriefingDate) setKv("last_briefing_date", state._lastBriefingDate);
    if (state.lastUpdated) setKv("state_last_updated", state.lastUpdated);
  },
  "lessons.json": file => {
    const data = readJson(file, e => { throw new Error(`lessons.json is unreadable: ${e.message}`); });
    for (const entry of data.performance ?? []) putDoc("performance", null, entry);
  },
  "pool-memory.json": file => {
    const data = readJson(file, e => { throw new Error(`pool-memory.json is unreadable: ${e.message}`); });
    for (const [address, entry] of Object.entries(data)) putDoc("pools", address, entry);
  },
  "token-blacklist.json": file => {
    const data = readJson(file, () => { throw new Error(`Safety blacklist is unreadable: ${file}`); });
    const insert = db.prepare("INSERT OR REPLACE INTO token_blacklist (mint, symbol, reason, added_at, added_by) VALUES (?, ?, ?, ?, ?)");
    for (const [mint, e] of Object.entries(data)) insert.run(...[mint, e.symbol, e.reason, e.added_at, e.added_by].map(bindable));
  },
  "dev-blocklist.json": file => {
    const data = readJson(file, () => { throw new Error(`Safety blocklist is unreadable: ${file}`); });
    const insert = db.prepare("INSERT OR REPLACE INTO dev_blocklist (wallet, label, reason, added_at) VALUES (?, ?, ?, ?)");
    for (const [wallet, e] of Object.entries(data)) insert.run(...[wallet, e.label, e.reason, e.added_at].map(bindable));
  },
  "decision-log.json": file => {
    const data = readJson(file, e => { throw new Error(`decision-log.json is unreadable: ${e.message}`); });
    for (const d of data.decisions ?? []) putDoc("decisions", d.id, d);
  },
  "wallet-monitor-state.json": file => {
    const data = readJson(file, e => { throw new Error(`Invalid monitor state (${e.message}); refusing to discard recovery history`); });
    if (data.version !== 1 || !data.attempts || typeof data.attempts !== "object") throw new Error("Invalid monitor state; refusing to discard recovery history");
    for (const [mint, s] of Object.entries(data.signals ?? {})) putDoc("signals", mint, s);
    for (const [mint, a] of Object.entries(data.attempts)) putDoc("attempts", mint, a);
    // Keys from the retired smart-wallet monitor are dropped; anything else is kept.
    const { version, signals, attempts, wallets, pending, seen, events, ...extras } = data;
    setKv("monitor_extras", extras);
  },
};

function importLegacyJson(dir) {
  for (const [name, load] of Object.entries(LEGACY)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    if (getKv(`imported:${name}`)) {
      log("db_warn", `${name} reappeared after its import into the database — left untouched`);
      continue;
    }
    tx(() => { load(file); setKv(`imported:${name}`, new Date().toISOString()); });
    fs.renameSync(file, `${file}.migrated`);
    log("db", `Imported ${name} into ${path.basename(dbPath())} (original kept as ${name}.migrated)`);
  }
}
