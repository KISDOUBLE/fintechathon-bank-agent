import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, DEFAULT_THRESHOLDS, LEVEL } from '../src/core/risk.mjs';

const base = { tool: 'transfer_create', amountCents: 10_000, reversible: false, payeeFirstTime: false, payeeLabel: '王小明' };

test('无命中为绿色', () => {
  const r = assessRisk({ ...base, reversible: true, amountCents: 1_000 }, {});
  assert.equal(r.level, LEVEL.GREEN);
  assert.equal(r.hits.length, 0);
});

test('单笔金额：中额黄、大额红，detail 带具体数字', () => {
  const y = assessRisk({ ...base, amountCents: DEFAULT_THRESHOLDS.singleWarnCents }, {});
  assert.equal(y.level, LEVEL.YELLOW);
  const hit = y.hits.find((h) => h.rule === 'R-AMT-SINGLE-WARN');
  assert.ok(hit);
  assert.match(hit.detail, /¥5,000\.00/);

  const r = assessRisk({ ...base, amountCents: DEFAULT_THRESHOLDS.singleBlockCents }, {});
  assert.equal(r.level, LEVEL.RED);
  assert.ok(r.hits.some((h) => h.rule === 'R-AMT-SINGLE-BLOCK'));
});

test('日累计：合并计算并说明前后金额', () => {
  const r = assessRisk(
    { ...base, amountCents: 500_000 },
    { dailySpentCents: 1_600_000 },
  );
  const hit = r.hits.find((h) => h.rule === 'R-AMT-DAILY-BLOCK');
  assert.ok(hit);
  assert.match(hit.detail, /¥16,000\.00/);
  assert.match(hit.detail, /¥21,000\.00/);
});

test('首次收款人：阈值内不提示，超过提示线变黄', () => {
  const none = assessRisk({ ...base, amountCents: 50_000, payeeFirstTime: true }, {});
  assert.equal(none.hits.some((h) => h.rule.startsWith('R-PAYEE')), false);

  const warn = assessRisk({ ...base, amountCents: 100_000, payeeFirstTime: true }, {});
  assert.ok(warn.hits.some((h) => h.rule === 'R-PAYEE-FIRST-WARN'));
});

test('可逆性：不可撤销操作给黄条', () => {
  const r = assessRisk({ ...base, amountCents: 10_000, reversible: false }, {});
  assert.ok(r.hits.some((h) => h.rule === 'R-IRREVERSIBLE'));
});

test('频次：10 分钟与 24 小时两条独立规则', () => {
  const r = assessRisk({ ...base, amountCents: 10_000 }, { count10m: 4, count24h: 6 });
  assert.ok(r.hits.some((h) => h.rule === 'R-FREQ-10M-WARN'));
  assert.ok(r.hits.some((h) => h.rule === 'R-FREQ-24H-BLOCK'));
  assert.equal(r.level, LEVEL.RED);
});

test('新设备抬升为黄', () => {
  const r = assessRisk({ ...base, amountCents: 10_000 }, { newDevice: true });
  assert.ok(r.hits.some((h) => h.rule === 'R-DEVICE-NEW'));
});

test('判定是纯函数：不修改入参与快照', () => {
  const input = Object.freeze({ ...base, amountCents: 500_000 });
  const state = Object.freeze({ dailySpentCents: 0, count10m: 0, count24h: 0 });
  assert.doesNotThrow(() => assessRisk(input, state));
  assert.equal(input.amountCents, 500_000);
  assert.equal(state.dailySpentCents, 0);
});
