/**
 * Mock 核心银行：SQLite + 复式记账。
 * 每笔资金动作产生借贷两条分录，借方合计 + 贷方合计 = 0，任一事务内校验。
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SUSPENSE_ACCOUNT, EQUITY_ACCOUNT } from './schema.mjs';
import { assertCents } from '../core/money.mjs';
import { hashPin, verifyPin } from '../auth/session.mjs';

const iso = (d = new Date()) => d.toISOString();

export class BankDB {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  /** 轻量迁移：老库缺列时补上，避免必须删库 */
  migrate() {
    const cols = this.db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('pin_hash')) {
      this.db.exec('ALTER TABLE users ADD COLUMN pin_salt TEXT');
      this.db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT');
    }
    const ccols = this.db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
    if (!ccols.includes('alias')) {
      this.db.exec('ALTER TABLE contacts ADD COLUMN alias TEXT');
    }
  }

  /** 设置登录 PIN（只存 scrypt 派生值，不存明文） */
  setUserPin(userId, pin) {
    const { salt, hash } = hashPin(pin);
    this.db.prepare('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, userId);
  }

  /** 校验 PIN；返回用户行或 null */
  authenticatePin(userId, pin) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row || row.locked) return null;
    return verifyPin(pin, row.pin_salt, row.pin_hash) ? row : null;
  }

  close() {
    this.db.close();
  }

  /** 事务包装：失败自动回滚 */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- 查询 ----------
  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
  }

  getUserByPhone(phone) {
    return this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) ?? null;
  }

  listUsers() {
    return this.db.prepare('SELECT id,name,phone FROM users ORDER BY id').all();
  }

  accountOf(userId) {
    return this.db.prepare('SELECT * FROM accounts WHERE user_id = ? AND kind = ?').get(userId, 'checking') ?? null;
  }

  accountById(id) {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) ?? null;
  }

  /** 按姓名、别名或手机号在本人通讯录里找收款人 */
  findContact(userId, keyword) {
    const kw = String(keyword ?? '').trim();
    if (!kw) return [];
    return this.db
      .prepare(
        `SELECT * FROM contacts
         WHERE user_id = ?
           AND (name = ? OR alias = ? OR phone = ? OR name LIKE ? OR alias LIKE ?)
         ORDER BY CASE WHEN name = ? OR alias = ? THEN 0 ELSE 1 END, name`,
      )
      .all(userId, kw, kw, kw, `%${kw}%`, `%${kw}%`, kw, kw);
  }

  listContacts(userId) {
    return this.db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY name').all(userId);
  }

  // ---------- 资金动作 ----------

  /**
   * 转账：from 账户 → to 账户（外部收款人进 SUSPENSE）。
   * idempotencyKey 相同则直接返回原交易，不重复扣款。
   */
  transfer({ traceId, fromUserId, toAccountId, amountCents, memo = '', category = '转账', merchant = null, idempotencyKey }) {
    assertCents(amountCents, '转账金额');
    if (fromUserId === toUserIdOfAccount(this, toAccountId)) {
      throw codedError('SELF_TRANSFER', '不能向自己转账');
    }
    const id = `txn_${createHash('sha256').update(`${traceId}:${idempotencyKey ?? randomUUID()}`).digest('hex').slice(0, 16)}`;

    const existing = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (existing) return { ...existing, idempotent: true };

    return this.tx(() => {
      const from = this.accountOf(fromUserId);
      if (!from) throw codedError('NO_ACCOUNT', '付款账户不存在');
      const to = this.accountById(toAccountId);
      if (!to) throw codedError('NO_PAYEE_ACCOUNT', '收款账户不存在');
      if (from.balance_cents < amountCents) {
        throw codedError('INSUFFICIENT_FUNDS', '余额不足');
      }
      const at = iso();
      this.db
        .prepare(
          `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, merchant, category, memo, created_at)
           VALUES (?, ?, 'transfer', 'committed', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, traceId, amountCents, from.id, to.id, merchant, category, memo, at);

      const insEntry = this.db.prepare('INSERT INTO entries (txn_id, account_id, delta_cents, created_at) VALUES (?, ?, ?, ?)');
      insEntry.run(id, from.id, -amountCents, at);
      insEntry.run(id, to.id, amountCents, at);

      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, from.id);
      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, to.id);

      this.assertBalanced(id);
      return this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    });
  }

  /** 单笔交易借贷必须平衡 */
  assertBalanced(txnId) {
    const row = this.db.prepare('SELECT COALESCE(SUM(delta_cents),0) AS s FROM entries WHERE txn_id = ?').get(txnId);
    if (row.s !== 0) {
      throw codedError('UNBALANCED_ENTRY', `分录不平：txn ${txnId} 合计 ${row.s}`);
    }
  }

  /** 全账本平衡校验：所有分录合计必须为 0 */
  globalBalance() {
    return this.db.prepare('SELECT COALESCE(SUM(delta_cents),0) AS s FROM entries').get().s;
  }

  // ---------- 统计（供风控只读快照使用） ----------

  /** 当日（UTC 日起）已转出总额，整数分 */
  dailySpentCents(userId, sinceIso) {
    const acct = this.accountOf(userId);
    if (!acct) return 0;
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions
         WHERE from_account = ? AND type = 'transfer' AND status = 'committed' AND created_at >= ?`,
      )
      .get(acct.id, sinceIso);
    return row.s;
  }

  countTransfers(userId, sinceIso) {
    const acct = this.accountOf(userId);
    if (!acct) return 0;
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE from_account = ? AND type = 'transfer' AND status = 'committed' AND created_at >= ?`,
      )
      .get(acct.id, sinceIso).n;
  }

  /** 该收款账户是否首次收款（历史上没有成功收款记录） */
  isFirstTimePayee(toAccountId) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE to_account = ? AND status = 'committed'")
      .get(toAccountId);
    return row.n === 0;
  }

  // ---------- 账单 ----------

  expenses(userId, sinceIso) {
    const acct = this.accountOf(userId);
    if (!acct) return [];
    return this.db
      .prepare(
        `SELECT id, amount_cents, merchant, category, memo, created_at FROM transactions
         WHERE from_account = ? AND type = 'payment' AND status = 'committed' AND created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(acct.id, sinceIso);
  }

  listTransactions(userId, limit = 20) {
    const acct = this.accountOf(userId);
    if (!acct) return [];
    return this.db
      .prepare(
        `SELECT id, type, status, amount_cents, merchant, category, memo, created_at,
                CASE WHEN from_account = ? THEN 'out' ELSE 'in' END AS direction
         FROM transactions WHERE from_account = ? OR to_account = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(acct.id, acct.id, acct.id, limit);
  }

  // ---------- 订阅 ----------

  subscriptions(userId) {
    return this.db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY next_charge_at')
      .all(userId);
  }

  cancelSubscription(userId, subscriptionId) {
    return this.tx(() => {
      const sub = this.db
        .prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?')
        .get(subscriptionId, userId);
      if (!sub) throw codedError('SUBSCRIPTION_NOT_FOUND', '订阅不存在或不属于当前用户');
      if (sub.status === 'cancelled') return { ...sub, alreadyCancelled: true };
      this.db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").run(subscriptionId);
      return { ...sub, status: 'cancelled' };
    });
  }

  // ---------- 系统账户 ----------

  ensureSystemAccounts() {
    const now = iso();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO users (id, name, phone, kyc_level, created_at) VALUES (?, ?, ?, 0, ?)');
    stmt.run('sys', '系统', 'SYS-0000', now);
    const acct = this.db.prepare('INSERT OR IGNORE INTO accounts (id, user_id, kind, balance_cents) VALUES (?, ?, ?, ?)');
    acct.run(SUSPENSE_ACCOUNT, 'sys', 'suspense', 0);
    acct.run(EQUITY_ACCOUNT, 'sys', 'equity', 0);
  }
}

function toUserIdOfAccount(db, accountId) {
  return db.accountById(accountId)?.user_id ?? null;
}

export function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
