import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, extractAmount, extractPayee, INTENT } from '../src/agent/parser.mjs';

test('余额与账单意图', () => {
  assert.equal(parse('查一下余额').intent, INTENT.QUERY_BALANCE);
  assert.equal(parse('帮我分析一下本月账单').intent, INTENT.BILL);
  assert.equal(parse('看看我上个月吃饭花了多少钱').slots.days, 30);
});

test('转账：姓名 + 阿拉伯数字', () => {
  const r = parse('转给王小明 500 元');
  assert.equal(r.intent, INTENT.TRANSFER);
  assert.equal(r.slots.payee, '王小明');
  assert.equal(r.slots.amountCents, 50_000);
  assert.deepEqual(r.missing, []);
});

test('转账：手机号作收款人', () => {
  const r = parse('转给 13800000003 500 块');
  assert.equal(r.slots.payee, '13800000003');
  assert.equal(r.slots.amountCents, 50_000);
});

test('转账：口语金额“五千块”', () => {
  assert.equal(parse('转给王小明五千块').slots.amountCents, 500_000);
});

test('转账：给…转 句式与备注', () => {
  const r = parse('给李娜转 200 元，备注 房租');
  assert.equal(r.slots.payee, '李娜');
  assert.equal(r.slots.amountCents, 20_000);
  assert.equal(r.slots.memo, '房租');
});

test('缺金额时进入追问', () => {
  const r = parse('转给王小明');
  assert.equal(r.intent, INTENT.TRANSFER);
  assert.ok(r.missing.includes('amount'));
});

test('多轮只补金额', () => {
  const first = parse('转给王小明');
  const second = parse('500', { pending: { intent: INTENT.TRANSFER, slots: { payee: first.slots.payee } } });
  assert.equal(second.intent, INTENT.TRANSFER);
  assert.equal(second.slots.payee, '王小明');
  assert.equal(second.slots.amountCents, 50_000);
  assert.equal(second.reason, 'MULTI_TURN_AMOUNT_FILL');
});

test('按备注转账被策略拒绝', () => {
  const r = parse('按备注转账给李叔 300 元');
  assert.equal(r.intent, INTENT.REJECTED);
  assert.equal(r.reason, 'POLICY_MEMO_TRANSFER');
});

test('订阅取消与列表', () => {
  assert.equal(parse('取消某某视频会员').intent, INTENT.SUB_CANCEL);
  assert.equal(parse('我有哪些订阅').intent, INTENT.SUB_LIST);
});

test('抽取金额不把手机号当金额', () => {
  const a = extractAmount('转给 13800000003 500 块');
  assert.equal(a.cents, 50_000);
  assert.equal(extractPayee('转给 13800000003 500 块'), '13800000003');
});
