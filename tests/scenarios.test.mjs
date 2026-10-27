import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, chat, confirm } from './helpers.mjs';

// ---------------- 理财 ----------------
test('理财：列出产品与持仓', async () => {
  const app = makeApp();
  const out = await chat(app, '我有哪些理财产品');
  assert.equal(out.status, 'ok');
  assert.equal(out.level, 'green');
  assert.ok(out.data.products.length >= 4);
  assert.match(out.reply, /在售产品/);
});

test('理财：按风险推荐', async () => {
  const app = makeApp();
  const out = await chat(app, '推荐稳健理财');
  assert.equal(out.status, 'ok');
  assert.ok(out.data.picks.every((p) => p.riskLevel <= 2));
});

test('理财：申购需 L3 多因子，确认后扣款并生成持仓', async () => {
  const app = makeApp();
  const before = app.db.accountOf('u_1001').balance_cents;

  const out = await chat(app, '申购稳健债券 2000 元');
  assert.equal(out.status, 'need_confirm');
  assert.equal(out.confirm.level, 'L3');
  assert.equal(out.confirm.mfaRequired, true);

  const done = await confirm(app, out.confirm.token, out.confirm.demoMfaCode);
  assert.equal(done.status, 'ok');
  assert.equal(app.db.accountOf('u_1001').balance_cents, before - 200_000);
  assert.equal(app.db.holdings('u_1001').filter((h) => h.status === 'active').length, 1);
});

test('理财：赎回返还本金并计息', async () => {
  const app = makeApp();
  const buy = await chat(app, '申购稳健债券 2000 元');
  await confirm(app, buy.confirm.token, buy.confirm.demoMfaCode);

  const sell = await chat(app, '赎回稳健债券');
  assert.equal(sell.status, 'need_confirm');
  const done = await confirm(app, sell.confirm.token, sell.confirm.demoMfaCode);
  assert.equal(done.status, 'ok');
  assert.match(done.reply, /已赎回/);
  assert.equal(app.db.holdings('u_1001').filter((h) => h.status === 'active').length, 0);
});

// ---------------- 卡片 ----------------
test('卡片：列表、申请、调额、冻结、解冻', async () => {
  const app = makeApp();

  const list = await chat(app, '我的卡有哪些');
  assert.equal(list.status, 'ok');
  assert.equal(list.data.count, 1);

  const apply = await chat(app, '申请一张虚拟卡');
  assert.equal(apply.status, 'need_confirm');
  const applied = await confirm(app, apply.confirm.token);
  assert.equal(applied.status, 'ok');
  assert.equal(app.db.listCards('u_1001').length, 2);

  const limit = await chat(app, '把尾号 8899 的日限额调到 5000 元');
  assert.equal(limit.confirm.level, 'L3');
  const limited = await confirm(app, limit.confirm.token, limit.confirm.demoMfaCode);
  assert.equal(limited.status, 'ok');
  assert.equal(app.db.findCard('u_1001', '8899').daily_limit_cents, 500_000);

  const freeze = await chat(app, '我卡丢了，帮我挂失');
  assert.equal(freeze.confirm.level, 'L3');
  const frozen = await confirm(app, freeze.confirm.token, freeze.confirm.demoMfaCode);
  assert.equal(frozen.status, 'ok');
  assert.equal(app.db.findCard('u_1001', '8899').status, 'frozen');

  const unfreeze = await chat(app, '解挂');
  const unfrozen = await confirm(app, unfreeze.confirm.token, unfreeze.confirm.demoMfaCode);
  assert.equal(unfrozen.status, 'ok');
  assert.equal(app.db.findCard('u_1001', '8899').status, 'active');
});

// ---------------- 定时转账 ----------------
test('定时转账：创建、列出、取消', async () => {
  const app = makeApp();
  const out = await chat(app, '明天给王小明转 300 元');
  assert.equal(out.status, 'need_confirm');
  const done = await confirm(app, out.confirm.token);
  assert.equal(done.status, 'ok');
  assert.equal(app.db.listScheduled('u_1001').length, 1);

  const list = await chat(app, '我的定时转账');
  assert.equal(list.status, 'ok');
  assert.equal(list.data.count, 1);

  const cancel = await chat(app, '取消定时转账');
  assert.equal(cancel.status, 'need_confirm');
  const cancelled = await confirm(app, cancel.confirm.token);
  assert.equal(cancelled.status, 'ok');
  assert.equal(app.db.listScheduled('u_1001').length, 0);
});

// ---------------- AA 平摊 ----------------
test('AA 平摊：一次确认向多人付款', async () => {
  const app = makeApp();
  const before = app.db.accountOf('u_1001').balance_cents;
  const out = await chat(app, '和小王、李娜平摊 300 元');
  assert.equal(out.status, 'need_confirm');
  assert.match(out.confirm.summary, /¥300\.00/);

  const done = await confirm(app, out.confirm.token);
  assert.equal(done.status, 'ok');
  assert.equal(app.db.accountOf('u_1001').balance_cents, before - 30_000);
});

// ---------------- 订阅识别 ----------------
test('订阅识别：从流水发现周期性扣费', async () => {
  const app = makeApp();
  // 造三笔同商户同金额的历史扣费
  const ins = app.db.db.prepare(
    `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, merchant, category, memo, created_at)
     VALUES (?, 'seed', 'payment', 'committed', 1500, 'acc_1001', 'EXT_SUSPENSE', '某某云服务', '订阅', '', ?)`,
  );
  for (const d of [10, 40, 70]) {
    ins.run(`txn_sub_${d}`, new Date(Date.now() - d * 86_400_000).toISOString());
  }

  const out = await chat(app, '帮我看看有哪些订阅在扣费');
  assert.equal(out.status, 'ok');
  assert.ok(out.data.count >= 1);
  assert.ok(out.data.items.some((i) => i.merchant === '某某云服务' && i.count === 3));
});

// ---------------- 跨场景 ----------------
test('跨场景：生日锁定预算并预订鲜花蛋糕', async () => {
  const app = makeApp();
  const before = app.db.accountOf('u_1001').balance_cents;
  const out = await chat(app, '帮我安排我爱人的生日，11 月 20 日，预算 800 元');
  assert.equal(out.status, 'need_confirm');
  assert.match(out.confirm.summary, /¥800\.00/);

  const done = await confirm(app, out.confirm.token);
  assert.equal(done.status, 'ok');
  assert.equal(app.db.accountOf('u_1001').balance_cents, before - 80_000);
  assert.equal(app.db.listEvents('u_1001').length, 1);
  assert.equal(app.db.listOrders(app.db.listEvents('u_1001')[0].id).length, 2);
});

// ---------------- 应变能力 ----------------
test('应变：办不了的事说清能力边界', async () => {
  const app = makeApp();
  const out = await chat(app, '帮我把房贷提前还了');
  assert.equal(out.status, 'clarify');
  assert.match(out.reply, /我能办这些/);
});

test('应变：打错一个字也能找到收款人', async () => {
  const app = makeApp();
  const out = await chat(app, '转给王小明 100 元');
  assert.equal(out.status, 'need_confirm');
  const typo = await chat(app, '转给王小朋 100 元');
  assert.equal(typo.status, 'need_confirm');
  assert.match(typo.confirm.summary, /王小明/);
});

test('应变：待确认时说“算了”直接取消', async () => {
  const app = makeApp();
  const out = await chat(app, '转给王小明 300 元');
  assert.equal(out.status, 'need_confirm');

  const cancel = await chat(app, '算了');
  assert.equal(cancel.status, 'ok');
  assert.match(cancel.reply, /已取消/);
  assert.equal(app.db.accountOf('u_1001').balance_cents, 5_230_000);
});
