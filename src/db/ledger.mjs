/**
 * Mock 核心银行：SQLite + 复式记账。
 * 每笔资金动作产生借贷两条分录，借方合计 + 贷方合计 = 0，任一事务内校验。
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SUSPENSE_ACCOUNT, EQUITY_ACCOUNT, WEALTH_POOL, RESERVE_ACCOUNT, YIELD_ACCOUNT } from './schema.mjs';
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

  /** 开户注册：建用户 + 活期账户 + 演示见面礼（复式记账），返回用户与账户 */
  registerUser({ name, phone, pin, welcomeCents = 100_000 }) {
    if (this.getUserByPhone(phone)) throw codedError('PHONE_TAKEN', '该手机号已注册');
    const id = `u_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const acctId = `acc_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = iso();

    return this.tx(() => {
      this.db
        .prepare('INSERT INTO users (id, name, phone, kyc_level, locked, created_at) VALUES (?, ?, ?, 1, 0, ?)')
        .run(id, name, phone, now);
      this.setUserPin(id, pin);
      this.db
        .prepare('INSERT INTO accounts (id, user_id, kind, balance_cents) VALUES (?, ?, ?, ?)')
        .run(acctId, id, 'checking', welcomeCents);

      if (welcomeCents > 0) {
        const txnId = `txn_welcome_${id}`;
        this.db
          .prepare(
            `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, memo, category, created_at)
             VALUES (?, 'register', 'topup', 'committed', ?, ?, ?, '开户演示资金', '开户', ?)`,
          )
          .run(txnId, welcomeCents, EQUITY_ACCOUNT, acctId, now);
        const insEntry = this.db.prepare('INSERT INTO entries (txn_id, account_id, delta_cents, created_at) VALUES (?, ?, ?, ?)');
        insEntry.run(txnId, EQUITY_ACCOUNT, -welcomeCents, now);
        insEntry.run(txnId, acctId, welcomeCents, now);
        this.assertBalanced(txnId);
      }
      return this.db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(id);
    });
  }

  /** 新增收款人；手机号若已注册，自动关联内部账户 */
  addContact(userId, { name, phone = null, alias = null }) {
    const exists = this.db.prepare('SELECT id FROM contacts WHERE user_id = ? AND name = ?').get(userId, name);
    if (exists) throw codedError('CONTACT_EXISTS', '该收款人已存在');
    const target = phone ? this.getUserByPhone(phone) : null;
    const accountId = target ? this.accountOf(target.id)?.id ?? null : null;
    const id = `c_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO contacts (id, user_id, name, alias, phone, tag, account_id) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(id, userId, name, alias, phone, accountId);
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
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

  /** 按姓名、别名或手机号在本人通讯录里找收款人；找不到时做一次编辑距离容错 */
  findContact(userId, keyword) {
    const kw = String(keyword ?? '').trim();
    if (!kw) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM contacts
         WHERE user_id = ?
           AND (name = ? OR alias = ? OR phone = ? OR name LIKE ? OR alias LIKE ?)
         ORDER BY CASE WHEN name = ? OR alias = ? THEN 0 ELSE 1 END, name`,
      )
      .all(userId, kw, kw, kw, `%${kw}%`, `%${kw}%`, kw, kw);
    if (rows.length) return rows;

    // 打错一个字也能认出来（编辑距离 ≤ 1），但只返回最接近的一批
    const all = this.listContacts(userId);
    const scored = all
      .map((c) => ({ c, d: Math.min(editDistance(kw, c.name), c.alias ? editDistance(kw, c.alias) : 99) }))
      .filter((x) => x.d <= 1)
      .sort((a, b) => a.d - b.d);
    return scored.map((x) => x.c);
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

  // ---------- 理财 ----------
  listProducts() {
    return this.db.prepare('SELECT * FROM products ORDER BY risk_level, id').all();
  }

  findProduct(keyword) {
    const kw = `%${String(keyword ?? '')}%`;
    return this.db.prepare('SELECT * FROM products WHERE name LIKE ? OR id = ? ORDER BY risk_level').all(kw, String(keyword ?? ''));
  }

  holdings(userId) {
    return this.db
      .prepare(
        `SELECT h.*, p.name AS product_name, p.risk_level, p.annual_rate_bp
         FROM holdings h JOIN products p ON p.id = h.product_id
         WHERE h.user_id = ? ORDER BY h.created_at DESC`,
      )
      .all(userId);
  }

  subscribeWealth({ userId, productId, amountCents, traceId }) {
    assertCents(amountCents, '申购金额');
    return this.tx(() => {
      const p = this.db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!p) throw codedError('PRODUCT_NOT_FOUND', '产品不存在');
      if (amountCents < p.min_amount_cents) {
        throw codedError('BELOW_MIN', `起购金额 ${(p.min_amount_cents / 100).toFixed(2)} 元`);
      }
      const acct = this.accountOf(userId);
      if (!acct) throw codedError('NO_ACCOUNT', '账户不存在');
      if (acct.balance_cents < amountCents) throw codedError('INSUFFICIENT_FUNDS', '余额不足');

      const now = iso();
      const id = `hld_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      this.db
        .prepare("INSERT INTO holdings (id, user_id, product_id, amount_cents, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
        .run(id, userId, productId, amountCents, now);

      const txnId = `txn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      this.db
        .prepare(
          `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, memo, category, created_at)
           VALUES (?, ?, 'wealth_buy', 'committed', ?, ?, ?, ?, '理财', ?)`,
        )
        .run(txnId, traceId, amountCents, acct.id, WEALTH_POOL, `申购 ${p.name}`, now);
      const ins = this.db.prepare('INSERT INTO entries (txn_id, account_id, delta_cents, created_at) VALUES (?, ?, ?, ?)');
      ins.run(txnId, acct.id, -amountCents, now);
      ins.run(txnId, WEALTH_POOL, amountCents, now);
      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, acct.id);
      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, WEALTH_POOL);
      this.assertBalanced(txnId);

      return { holdingId: id, product: p, amountCents, balanceAfterCents: this.accountOf(userId).balance_cents };
    });
  }

  redeemWealth({ userId, holdingId, traceId }) {
    return this.tx(() => {
      const h = this.db
        .prepare('SELECT h.*, p.name AS product_name, p.annual_rate_bp FROM holdings h JOIN products p ON p.id=h.product_id WHERE h.id = ? AND h.user_id = ?')
        .get(holdingId, userId);
      if (!h) throw codedError('HOLDING_NOT_FOUND', '持仓不存在');
      if (h.status !== 'active') throw codedError('ALREADY_REDEEMED', '该持仓已赎回');

      const days = Math.max(0, Math.floor((Date.now() - new Date(h.created_at).getTime()) / 86_400_000));
      // 单利，整数分：本金 × 年化 × 天数 / (10000 × 365)
      const interest = Math.floor((h.amount_cents * h.annual_rate_bp * days) / (10000 * 365));
      const total = h.amount_cents + interest;
      const now = iso();
      const acct = this.accountOf(userId);

      const txnId = `txn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      this.db
        .prepare(
          `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, memo, category, created_at)
           VALUES (?, ?, 'wealth_redeem', 'committed', ?, ?, ?, ?, '理财', ?)`,
        )
        .run(txnId, traceId, total, WEALTH_POOL, acct.id, `赎回 ${h.product_name}`, now);
      const ins = this.db.prepare('INSERT INTO entries (txn_id, account_id, delta_cents, created_at) VALUES (?, ?, ?, ?)');
      ins.run(txnId, WEALTH_POOL, -h.amount_cents, now);
      if (interest > 0) ins.run(txnId, YIELD_ACCOUNT, -interest, now);
      ins.run(txnId, acct.id, total, now);
      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(h.amount_cents, WEALTH_POOL);
      if (interest > 0) {
        this.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(interest, YIELD_ACCOUNT);
      }
      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(total, acct.id);
      this.db.prepare("UPDATE holdings SET status='redeemed', redeemed_at=? WHERE id=?").run(now, holdingId);
      this.assertBalanced(txnId);

      return { productName: h.product_name, principalCents: h.amount_cents, interestCents: interest, days, totalCents: total, balanceAfterCents: this.accountOf(userId).balance_cents };
    });
  }

  // ---------- 卡片 ----------
  listCards(userId) {
    return this.db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id').all(userId);
  }

  findCard(userId, last4) {
    return this.db.prepare('SELECT * FROM cards WHERE user_id = ? AND last4 = ?').get(userId, String(last4 ?? ''));
  }

  applyCard({ userId, brand = '虚拟卡' }) {
    const id = `card_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    this.db
      .prepare('INSERT INTO cards (id, user_id, brand, last4, credit_limit_cents, daily_limit_cents, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, brand, last4, 2_000_000, 500_000, 'active');
    return this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  }

  setCardLimit(userId, cardId, limitCents) {
    const c = this.db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardId, userId);
    if (!c) throw codedError('CARD_NOT_FOUND', '卡片不存在');
    this.db.prepare('UPDATE cards SET daily_limit_cents = ? WHERE id = ?').run(limitCents, cardId);
    return { ...c, daily_limit_cents: limitCents, before: c.daily_limit_cents };
  }

  setCardStatus(userId, cardId, status) {
    const c = this.db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardId, userId);
    if (!c) throw codedError('CARD_NOT_FOUND', '卡片不存在');
    this.db.prepare('UPDATE cards SET status = ? WHERE id = ?').run(status, cardId);
    return { ...c, previous: c.status, status };
  }

  // ---------- 定时转账 ----------
  scheduleTransfer({ userId, payeeName, payeeAccount, amountCents, runAt }) {
    assertCents(amountCents, '定时转账金额');
    const id = `sch_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO scheduled_transfers (id, user_id, payee_name, payee_account, amount_cents, run_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, payeeName, payeeAccount, amountCents, runAt, 'scheduled', iso());
    return this.db.prepare('SELECT * FROM scheduled_transfers WHERE id = ?').get(id);
  }

  listScheduled(userId) {
    return this.db
      .prepare("SELECT * FROM scheduled_transfers WHERE user_id = ? AND status = 'scheduled' ORDER BY run_at")
      .all(userId);
  }

  cancelScheduled(userId, id) {
    const row = this.db.prepare('SELECT * FROM scheduled_transfers WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw codedError('SCHEDULE_NOT_FOUND', '定时转账不存在');
    if (row.status !== 'scheduled') throw codedError('SCHEDULE_NOT_ACTIVE', '该定时转账已结束');
    this.db.prepare("UPDATE scheduled_transfers SET status='cancelled' WHERE id=?").run(id);
    return { ...row, status: 'cancelled' };
  }

  // ---------- 订阅识别 ----------
  /** 从近 N 天流水中识别疑似周期性扣费：同商户 ≥3 次且金额接近 */
  detectRecurring(userId, days = 90) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const acct = this.accountOf(userId);
    if (!acct) return [];
    const rows = this.db
      .prepare(
        `SELECT merchant, amount_cents, created_at FROM transactions
         WHERE from_account = ? AND type = 'payment' AND status = 'committed' AND created_at >= ?
         ORDER BY merchant, created_at`,
      )
      .all(acct.id, since);

    const groups = new Map();
    for (const r of rows) {
      const g = groups.get(r.merchant) ?? [];
      g.push(r);
      groups.set(r.merchant, g);
    }
    const out = [];
    for (const [merchant, list] of groups) {
      if (list.length < 3) continue;
      const amounts = list.map((x) => x.amount_cents);
      const min = Math.min(...amounts);
      const max = Math.max(...amounts);
      if (max - min > Math.max(1000, Math.round(min * 0.15))) continue; // 金额波动过大不算
      out.push({
        merchant,
        count: list.length,
        avgCents: Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length),
        lastAt: list[list.length - 1].created_at,
      });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  // ---------- 跨场景事件 ----------
  createEvent({ userId, person, eventDate, budgetCents, traceId }) {
    assertCents(budgetCents, '预算金额');
    return this.tx(() => {
      const acct = this.accountOf(userId);
      if (!acct) throw codedError('NO_ACCOUNT', '账户不存在');
      if (acct.balance_cents < budgetCents) throw codedError('INSUFFICIENT_FUNDS', '余额不足，无法锁定预算');

      const now = iso();
      const id = `evt_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      this.db
        .prepare("INSERT INTO events (id, user_id, kind, person, event_date, budget_cents, status, created_at) VALUES (?, ?, 'birthday', ?, ?, ?, 'scheduled', ?)")
        .run(id, userId, person, eventDate, budgetCents, now);

      // 锁定预算：活期 → 预留账户
      const txnId = `txn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      this.db
        .prepare(
          `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, memo, category, created_at)
           VALUES (?, ?, 'reserve', 'committed', ?, ?, ?, ?, '跨场景', ?)`,
        )
        .run(txnId, traceId, budgetCents, acct.id, RESERVE_ACCOUNT, `${person}生日预算锁定`, now);
      const ins = this.db.prepare('INSERT INTO entries (txn_id, account_id, delta_cents, created_at) VALUES (?, ?, ?, ?)');
      ins.run(txnId, acct.id, -budgetCents, now);
      ins.run(txnId, RESERVE_ACCOUNT, budgetCents, now);
      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(budgetCents, acct.id);
      this.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(budgetCents, RESERVE_ACCOUNT);
      this.assertBalanced(txnId);

      // 提前 2 天预订鲜花与蛋糕
      const eventAt = new Date(eventDate);
      const orderAt = new Date(eventAt.getTime() - 2 * 86_400_000).toISOString();
      const flower = Math.round(budgetCents * 0.4);
      const cake = budgetCents - flower;
      const insOrder = this.db.prepare('INSERT INTO orders (id, event_id, vendor, item, amount_cents, scheduled_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
      insOrder.run(`ord_${randomUUID().slice(0, 8)}`, id, '本地鲜花店', '生日花束', flower, orderAt, 'scheduled');
      insOrder.run(`ord_${randomUUID().slice(0, 8)}`, id, '本地烘焙坊', '生日蛋糕', cake, orderAt, 'scheduled');

      return { event: this.db.prepare('SELECT * FROM events WHERE id = ?').get(id), orders: this.listOrders(id), balanceAfterCents: this.accountOf(userId).balance_cents };
    });
  }

  listEvents(userId) {
    return this.db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY event_date').all(userId);
  }

  listOrders(eventId) {
    return this.db.prepare('SELECT * FROM orders WHERE event_id = ? ORDER BY scheduled_at').all(eventId);
  }

  // ---------- 系统账户 ----------

  ensureSystemAccounts() {
    const now = iso();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO users (id, name, phone, kyc_level, created_at) VALUES (?, ?, ?, 0, ?)');
    stmt.run('sys', '系统', 'SYS-0000', now);
    const acct = this.db.prepare('INSERT OR IGNORE INTO accounts (id, user_id, kind, balance_cents) VALUES (?, ?, ?, ?)');
    acct.run(SUSPENSE_ACCOUNT, 'sys', 'suspense', 0);
    acct.run(EQUITY_ACCOUNT, 'sys', 'equity', 0);
    acct.run(WEALTH_POOL, 'sys', 'pool', 0);
    acct.run(RESERVE_ACCOUNT, 'sys', 'reserve', 0);
    acct.run(YIELD_ACCOUNT, 'sys', 'yield', 10_000_000);
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

/** 编辑距离（只关心 ≤1 的场景，超长直接返回大数） */
function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (Math.abs(s.length - t.length) > 1) return 99;
  const m = s.length;
  const n = t.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}
