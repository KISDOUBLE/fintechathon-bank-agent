/**
 * 数据库 schema。复式记账：transactions 是一次业务事件，entries 是借贷分录。
 * 约束写进 DDL：金额必须是正整数分，方向只能是 debit/credit。
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL UNIQUE,
  kyc_level   INTEGER NOT NULL DEFAULT 1,
  locked      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'CNY',
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0)
);
CREATE TABLE IF NOT EXISTS contacts (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id),
  name      TEXT NOT NULL,
  alias     TEXT,
  phone     TEXT,
  tag       TEXT,
  account_id TEXT,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  trace_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('committed','reversed')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL DEFAULT 'CNY',
  from_account TEXT,
  to_account   TEXT,
  merchant     TEXT,
  category     TEXT,
  memo         TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id      TEXT NOT NULL REFERENCES transactions(id),
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  delta_cents INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  merchant       TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  cycle          TEXT NOT NULL DEFAULT 'monthly',
  next_charge_at TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','cancelled')),
  last_charged_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  event       TEXT NOT NULL,
  level       TEXT,
  detail_json TEXT NOT NULL,
  at          TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_from ON transactions(from_account, created_at);
CREATE INDEX IF NOT EXISTS idx_txn_to ON transactions(to_account, created_at);
CREATE INDEX IF NOT EXISTS idx_entries_txn ON entries(txn_id);
`;

export const SUSPENSE_ACCOUNT = 'EXT_SUSPENSE';
export const EQUITY_ACCOUNT = 'SYS_EQUITY';
