import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'kitchen.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Everyone who has written in the group. jid is the WhatsApp id when known,
  -- or "name:<Name>" for people only seen in an imported chat export.
  CREATE TABLE IF NOT EXISTS people (
    jid   TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    phone TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    ts          INTEGER NOT NULL,
    sender_jid  TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    text        TEXT NOT NULL,
    source      TEXT NOT NULL,           -- 'live' | 'import'
    processed   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed, ts);

  CREATE TABLE IF NOT EXISTS sales (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,           -- YYYY-MM-DD (local)
    item        TEXT NOT NULL,
    qty         REAL NOT NULL DEFAULT 1,
    unit_price  REAL NOT NULL DEFAULT 0,
    total       REAL NOT NULL DEFAULT 0,
    customer    TEXT NOT NULL DEFAULT '',
    channel     TEXT NOT NULL DEFAULT '', -- e.g. Swiggy, Zomato, direct
    handled_by  TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'app', -- 'bot' | 'app'
    source_msg  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);

  CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    item        TEXT NOT NULL,
    amount      REAL NOT NULL DEFAULT 0,
    vendor      TEXT NOT NULL DEFAULT '',
    paid_by     TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'app',
    source_msg  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

  CREATE TABLE IF NOT EXISTS menu (
    item        TEXT PRIMARY KEY COLLATE NOCASE,
    price       REAL NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item        TEXT NOT NULL,
    old_price   REAL,
    new_price   REAL NOT NULL,
    ts          INTEGER NOT NULL,
    decided_by  TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    source_msg  TEXT
  );

  CREATE TABLE IF NOT EXISTS open_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    details          TEXT NOT NULL DEFAULT '',
    owner_jid        TEXT,
    owner_name       TEXT NOT NULL DEFAULT '',
    raised_at        INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open', -- 'open' | 'done'
    closed_at        INTEGER,
    closed_note      TEXT NOT NULL DEFAULT '',
    last_reminded_at INTEGER,
    source           TEXT NOT NULL DEFAULT 'app',
    source_msg       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_open_status ON open_items(status);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? null : String(value));
}

export function upsertPerson(jid, name) {
  db.prepare(
    `INSERT INTO people (jid, name) VALUES (?, ?)
     ON CONFLICT(jid) DO NOTHING`
  ).run(jid, name || jid.split('@')[0]);
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
