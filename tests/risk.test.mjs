import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, DEFAULT_THRESHOLDS, LEVEL } from '../src/core/risk.mjs';

const transfer = (amountCents, extra = {}) => ({
  tool: 'transfer_create', amountCents, reversible: false, payeeFirstTime: false, ...extra,
});

test('纯查询为绿色且无命中', () => {
  const r = assessRisk({ tool: 'query_balance', amountCents: 0, reversible: true }, {});
  assert.equal(r.level, LEVEL.GREEN);
  assert.equal(r.hits.length, 0);
  assert.equal(r.block, false);
});

test('日累计 ¥1,000 以内：黄色，二次确认', () => {
  const r = assessRisk(transfer(50_000), { dailySpentCents: 0 });
  assert.equal(r.level, LEVEL.YELLOW);
  assert.equal(r.block, false);
  const hit = r.hits.find((h) => h.rule === 'R-AMT-YELLOW-CONFIRM');
  assert.ok(hit);
  assert.match(hit.detail, /¥500\.00/);
  assert.match(hit.detail, /¥1,000\.00/);
});

test('日累计超过 ¥1,000：红色，强验证而非拒绝', () => {
  const r = assessRisk(transfer(150_000), { dailySpentCents: 0 });
  assert.equal(r.level, LEVEL.RED);
  assert.equal(r.block, false); // 关键：红色仍然可以走多因子放行
  const hit = r.hits.find((h) => h.rule === 'R-AMT-RED-VERIFY');
  assert.ok(hit);
  assert.match(hit.detail, /¥1,500\.00/);
});

test('已用额度会累计：先 800 再 500 → 超线', () => {
  const r = assessRisk(transfer(50_000), { dailySpentCents: 80_000 });
  assert.equal(r.level, LEVEL.RED);
  assert.match(r.hits[0].detail, /¥800\.00/);
  assert.match(r.hits[0].detail, /¥1,300\.00/);
});

test('单笔硬上限：¥50,000 直接拦截', () => {
  const r = assessRisk(transfer(DEFAULT_THRESHOLDS.blockSingleCents), {});
  assert.equal(r.block, true);
  assert.equal(r.level, LEVEL.RED);
  assert.ok(r.hits.some((h) => h.rule === 'R-LIMIT-SINGLE-BLOCK'));
});

test('日累计硬上限：超过 ¥20,000 拦截', () => {
  const r = assessRisk(transfer(500_000), { dailySpentCents: 1_600_000 });
  assert.equal(r.block, true);
  assert.ok(r.hits.some((h) => h.rule === 'R-LIMIT-DAILY-BLOCK'));
  assert.match(r.hits.find((h) => h.rule === 'R-LIMIT-DAILY-BLOCK').detail, /¥21,000\.00/);
});

test('首次收款人超过 ¥500 提示', () => {
  const hit = assessRisk(transfer(60_000, { payeeFirstTime: true }), {}).hits.find((h) => h.rule === 'R-PAYEE-FIRST');
  assert.ok(hit);
  assert.match(hit.detail, /¥600\.00/);

  const none = assessRisk(transfer(30_000, { payeeFirstTime: true }), {}).hits.find((h) => h.rule === 'R-PAYEE-FIRST');
  assert.equal(none, undefined);
});

test('不可撤销操作给黄条，零金额也判', () => {
  const r = assessRisk({ tool: 'subscription_cancel', amountCents: 0, reversible: false, payeeFirstTime: false }, {});
  assert.equal(r.level, LEVEL.YELLOW);
  assert.ok(r.hits.some((h) => h.rule === 'R-IRREVERSIBLE'));
});

test('频次：10 分钟黄，24 小时熔断', () => {
  const warn = assessRisk(transfer(10_000), { count10m: 4 });
  assert.ok(warn.hits.some((h) => h.rule === 'R-FREQ-10M-WARN'));

  const block = assessRisk(transfer(10_000), { count24h: 6 });
  assert.equal(block.block, true);
  assert.ok(block.hits.some((h) => h.rule === 'R-FREQ-24H-BLOCK'));
});

test('新设备提示', () => {
  const r = assessRisk(transfer(10_000), { newDevice: true });
  assert.ok(r.hits.some((h) => h.rule === 'R-DEVICE-NEW'));
});

test('判定是纯函数：不修改入参与快照', () => {
  const input = Object.freeze(transfer(150_000));
  const state = Object.freeze({ dailySpentCents: 0, count10m: 0, count24h: 0 });
  assert.doesNotThrow(() => assessRisk(input, state));
  assert.equal(input.amountCents, 150_000);
  assert.equal(state.dailySpentCents, 0);
});
