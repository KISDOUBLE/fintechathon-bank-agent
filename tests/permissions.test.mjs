import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, AMOUNT_ESCALATE_CENTS } from '../src/core/permissions.mjs';

const actor = { id: 'u_1001' };

test('只读工具为 L1，不需要确认', () => {
  const r = authorize({ actor, tool: 'query_balance', args: {} });
  assert.equal(r.allowed, true);
  assert.equal(r.level, 'L1');
  assert.equal(r.needConfirm, false);
});

test('转账基础 L2，达到金额线抬升 L3', () => {
  const small = authorize({ actor, tool: 'transfer_create', args: { amountCents: 50_000 } });
  assert.equal(small.level, 'L2');
  assert.equal(small.needConfirm, true);
  assert.equal(small.needMfa, false);

  const big = authorize({ actor, tool: 'transfer_create', args: { amountCents: AMOUNT_ESCALATE_CENTS } });
  assert.equal(big.level, 'L3');
  assert.equal(big.needMfa, true);
  assert.ok(big.reasons.some((x) => x.rule === 'P-AMOUNT-ESCALATE'));
});

test('跨用户访问一律 X 硬拒绝', () => {
  const r = authorize({ actor, tool: 'query_balance', args: { userId: 'u_1002' } });
  assert.equal(r.allowed, false);
  assert.equal(r.level, 'X');
  assert.equal(r.denyCode, 'cross_user');
});

test('未知工具拒绝', () => {
  const r = authorize({ actor, tool: 'wire_everything', args: {} });
  assert.equal(r.allowed, false);
  assert.equal(r.denyCode, 'unknown_tool');
});

test('锁定账户拒绝', () => {
  const r = authorize({ actor: { id: 'u_1001', locked: true }, tool: 'query_balance', args: {} });
  assert.equal(r.allowed, false);
  assert.equal(r.denyCode, 'actor_locked');
});

test('日累计硬上限在权限层直接拒绝', () => {
  const r = authorize({
    actor,
    tool: 'transfer_create',
    args: { amountCents: 1_000_000 },
    ctx: { dailySpentCents: 1_500_000 },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.denyCode, 'daily_limit');
});

test('新设备把 L2 抬到 L3', () => {
  const r = authorize({ actor, tool: 'transfer_create', args: { amountCents: 50_000 }, ctx: { newDevice: true } });
  assert.equal(r.level, 'L3');
  assert.ok(r.reasons.some((x) => x.rule === 'P-DEVICE-ESCALATE'));
});

test('动态授权只覆盖匹配工具且在有效期内', () => {
  const grant = { id: 'g1', tool: 'transfer_create', expiresAt: Date.now() + 60_000 };
  const ok = authorize({ actor, tool: 'transfer_create', args: { amountCents: 50_000 }, ctx: { grant } });
  assert.equal(ok.needConfirm, false);

  const expired = authorize({
    actor, tool: 'transfer_create', args: { amountCents: 50_000 },
    ctx: { grant: { ...grant, expiresAt: Date.now() - 1 } },
  });
  assert.equal(expired.needConfirm, true);

  const wrongTool = authorize({
    actor, tool: 'transfer_create', args: { amountCents: 50_000 },
    ctx: { grant: { ...grant, tool: 'other' } },
  });
  assert.equal(wrongTool.needConfirm, true);
});
