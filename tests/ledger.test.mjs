import test from 'node:test';
import assert from 'node:assert/strict';
import { BankDB } from '../src/db/ledger.mjs';
import { seed } from '../src/db/seed.mjs';

function fresh() {
  const db = new BankDB(':memory:');
  seed(db);
  return db;
}

test('种子数据后全账本借贷平衡', () => {
  const db = fresh();
  assert.equal(db.globalBalance(), 0);
});

test('转账生成借贷两条分录且余额正确', () => {
  const db = fresh();
  const before = db.accountOf('u_1001').balance_cents;
  const txn = db.transfer({
    traceId: 't1', fromUserId: 'u_1001', toAccountId: 'acc_1003', amountCents: 50_000, memo: '测试',
  });
  assert.equal(txn.status, 'committed');
  assert.equal(db.accountOf('u_1001').balance_cents, before - 50_000);
  const entries = db.db.prepare('SELECT delta_cents FROM entries WHERE txn_id = ?').all(txn.id);
  assert.equal(entries.reduce((s, e) => s + e.delta_cents, 0), 0);
  assert.equal(db.globalBalance(), 0);
});

test('幂等键重复提交不重复扣款', () => {
  const db = fresh();
  const before = db.accountOf('u_1001').balance_cents;
  const a = db.transfer({ traceId: 't2', fromUserId: 'u_1001', toAccountId: 'acc_1003', amountCents: 10_000, idempotencyKey: 'step1' });
  const b = db.transfer({ traceId: 't2', fromUserId: 'u_1001', toAccountId: 'acc_1003', amountCents: 10_000, idempotencyKey: 'step1' });
  assert.equal(a.id, b.id);
  assert.equal(b.idempotent, true);
  assert.equal(db.accountOf('u_1001').balance_cents, before - 10_000);
});

test('余额不足时报错且不产生分录', () => {
  const db = fresh();
  const before = db.accountOf('u_1001').balance_cents;
  assert.throws(
    () => db.transfer({ traceId: 't3', fromUserId: 'u_1001', toAccountId: 'acc_1003', amountCents: before + 1 }),
    /余额不足/,
  );
  assert.equal(db.accountOf('u_1001').balance_cents, before);
});

test('不能向自己转账', () => {
  const db = fresh();
  assert.throws(
    () => db.transfer({ traceId: 't4', fromUserId: 'u_1001', toAccountId: 'acc_1001', amountCents: 100 }),
    /自己/,
  );
});
