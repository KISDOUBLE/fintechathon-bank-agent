import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmountToCents, formatCents, cnIntegerToNumber } from '../src/core/money.mjs';

test('阿拉伯数字与千分位', () => {
  assert.equal(parseAmountToCents('5000'), 500_000);
  assert.equal(parseAmountToCents('5,000'), 500_000);
  assert.equal(parseAmountToCents('￥5,000.00'), 500_000);
  assert.equal(parseAmountToCents('12.34'), 1_234);
});

test('中文口语金额', () => {
  assert.equal(parseAmountToCents('五千块'), 500_000);
  assert.equal(parseAmountToCents('五百元'), 50_000);
  assert.equal(parseAmountToCents('十五块'), 1_500);
  assert.equal(cnIntegerToNumber('一万五千'), 15_000);
});

test('数量级写法', () => {
  assert.equal(parseAmountToCents('1.5万'), 1_500_000);
  assert.equal(parseAmountToCents('5千'), 500_000);
  assert.equal(parseAmountToCents('2百'), 20_000);
});

test('拒绝非法输入', () => {
  assert.equal(parseAmountToCents('5.001'), null); // 不足一分
  assert.equal(parseAmountToCents('abc'), null);
  assert.equal(parseAmountToCents(''), null);
  assert.throws(() => parseAmountToCents(5000.5), /浮点/); // 禁止浮点入口
});

test('格式化始终两位小数', () => {
  assert.equal(formatCents(500_000), '¥5,000.00');
  assert.equal(formatCents(1), '¥0.01');
  assert.equal(formatCents(123_456_789), '¥1,234,567.89');
});
