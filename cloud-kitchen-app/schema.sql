-- Cloud Kitchen Manager schema (SQLite). Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone             TEXT,              -- for WhatsApp reminders, e.g. +919812345678
    email             TEXT,              -- optional, for email reminders
    pin_hash          TEXT NOT NULL,     -- 4-digit PIN used to log in
    is_admin          INTEGER NOT NULL DEFAULT 0,
    can_finance       INTEGER NOT NULL DEFAULT 0,
    can_inventory     INTEGER NOT NULL DEFAULT 0,
    reminders_enabled INTEGER NOT NULL DEFAULT 1,
    active            INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per day: sales and money position.
CREATE TABLE IF NOT EXISTS finance_entries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date       TEXT NOT NULL UNIQUE,
    orders_count     INTEGER NOT NULL DEFAULT 0,
    sales_amount     REAL NOT NULL DEFAULT 0,
    money_received   REAL NOT NULL DEFAULT 0,
    money_receivable REAL NOT NULL DEFAULT 0,
    notes            TEXT,
    updated_by       INTEGER REFERENCES users(id),
    updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_date TEXT NOT NULL,
    category     TEXT NOT NULL,
    amount       REAL NOT NULL,
    note         TEXT,
    created_by   INTEGER REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

CREATE TABLE IF NOT EXISTS inventory_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    unit          TEXT NOT NULL DEFAULT 'kg',
    quantity      REAL NOT NULL DEFAULT 0,
    reorder_level REAL NOT NULL DEFAULT 0,
    updated_by    INTEGER REFERENCES users(id),
    updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every stock count / adjustment, so we know who updated what and when.
CREATE TABLE IF NOT EXISTS inventory_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    log_date   TEXT NOT NULL,
    old_qty    REAL NOT NULL,
    new_qty    REAL NOT NULL,
    note       TEXT,
    user_id    INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_log_date ON inventory_log(log_date);

-- "Inventory needed" list: things to buy / order.
CREATE TABLE IF NOT EXISTS inventory_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name  TEXT NOT NULL,
    quantity   REAL NOT NULL,
    unit       TEXT,
    needed_by  TEXT,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ordered', 'received', 'cancelled')),
    note       TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One reminder per user per day; the primary key doubles as a lock so that
-- multiple app processes never send the same reminder twice.
CREATE TABLE IF NOT EXISTS reminder_log (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_date TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'pending',
    detail    TEXT,
    sent_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, sent_date)
);
