/**
 * 权限分级：L0 / L1 / L2 / L3 / X。
 * 关键约束：本模块在“工具执行层”被独立调用，不依赖对话层结论。
 * 模型给出的 requires 字段一律忽略，级别由这里重新计算。
 */

import { DEFAULT_THRESHOLDS } from './risk.mjs';

export const LEVELS = Object.freeze({ L0: 'L0', L1: 'L1', L2: 'L2', L3: 'L3', X: 'X' });

const RANK = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** 工具的基础级别（未考虑金额与上下文抬升） */
export const TOOL_LEVEL = Object.freeze({
  fx_quote: LEVELS.L0,
  query_balance: LEVELS.L1,
  list_transactions: LEVELS.L1,
  list_contacts: LEVELS.L1,
  bill_analyze: LEVELS.L1,
  subscription_list: LEVELS.L1,
  subscription_detect: LEVELS.L1,
  wealth_list: LEVELS.L1,
  wealth_recommend: LEVELS.L1,
  card_list: LEVELS.L1,
  event_list: LEVELS.L1,
  transfer_schedule_list: LEVELS.L1,
  transfer_create: LEVELS.L2,
  subscription_cancel: LEVELS.L2,
  transfer_schedule_create: LEVELS.L2,
  transfer_schedule_cancel: LEVELS.L2,
  transfer_split: LEVELS.L2,
  card_apply: LEVELS.L2,
  birthday_setup: LEVELS.L2,
  wealth_subscribe: LEVELS.L3,
  wealth_redeem: LEVELS.L3,
  card_set_limit: LEVELS.L3,
  card_freeze: LEVELS.L3,
  card_unfreeze: LEVELS.L3,
});

/** 金额抬升基准：日累计超过该值即按 L3 处理（与赛题 ¥1,000 口径一致） */
export const AMOUNT_ESCALATE_CENTS = DEFAULT_THRESHOLDS.yellowDailyCents;

/**
 * @param {object} p
 * @param {{id:string, locked?:boolean}} p.actor
 * @param {string} p.tool
 * @param {{userId?:string, amountCents?:number}} p.args
 * @param {object} p.ctx  {newDevice, grant:{tool,scope,expiresAt,id}|null, thresholds}
 * @returns {{allowed:boolean, level:string, needConfirm:boolean, needMfa:boolean, denyCode:?string, reasons:Array}}
 */
export function authorize({ actor, tool, args = {}, ctx = {} }) {
  const reasons = [];
  const base = TOOL_LEVEL[tool];

  if (!base) {
    return deny('unknown_tool', LEVELS.X, `工具 ${tool} 不在白名单内`);
  }
  if (!actor || !actor.id) {
    return deny('no_actor', LEVELS.X, '缺少已认证主体');
  }
  if (actor.locked) {
    return deny('actor_locked', LEVELS.X, '账户已因异常熔断锁定，需人工解锁');
  }

  // 跨用户访问：一律 X，先于任何金额判断
  if (args.userId && args.userId !== actor.id) {
    return deny(
      'cross_user',
      LEVELS.X,
      `主体 ${actor.id} 试图访问 ${args.userId} 的数据，跨用户访问硬拒绝`,
    );
  }

  let level = base;
  const t = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds || {}) };
  const amount = args.amountCents ?? 0;

  // 三色判定给出的最低级别（红色 → 强验证）
  if (ctx.minLevel && RANK[ctx.minLevel] > RANK[level]) {
    level = ctx.minLevel;
    reasons.push({
      rule: 'P-RISK-ESCALATE',
      detail: `三色判定要求 ${ctx.minLevel}，工具基础级别 ${base} 被抬升`,
    });
  }

  if (ctx.newDevice && RANK[level] >= RANK.L2) {
    level = LEVELS.L3;
    reasons.push({
      rule: 'P-DEVICE-ESCALATE',
      detail: `新设备登录 2 小时内发起 ${tool}，级别抬升为 L3`,
    });
  }

  // 日累计硬上限：权限层直接拒绝，不再走确认
  const dailyAfter = (ctx.dailySpentCents ?? 0) + amount;
  if (RANK[level] >= RANK.L2 && dailyAfter > t.blockDailyCents) {
    return deny(
      'daily_limit',
      LEVELS.X,
      `当日累计将达 ¥${(dailyAfter / 100).toFixed(2)}，超过硬上限 ¥${(t.blockDailyCents / 100).toFixed(2)}`,
    );
  }

  // 任务级动态授权：只覆盖 L2，工具必须匹配，且对象必须在授权范围内
  const grant = ctx.grant;
  const inScope =
    !grant?.scopeIds || grant.scopeIds.includes(args.subscriptionId ?? args.payee ?? args.accountId);
  if (grant && grant.tool === tool && grant.expiresAt > Date.now() && level === LEVELS.L2 && inScope) {
    reasons.push({
      rule: 'P-GRANT',
      detail: `命中任务级授权 ${grant.id}（工具 ${tool}，剩余 ${Math.ceil((grant.expiresAt - Date.now()) / 1000)} 秒）`,
    });
    return {
      allowed: true,
      level,
      needConfirm: false,
      needMfa: false,
      denyCode: null,
      reasons,
    };
  }

  return {
    allowed: true,
    level,
    needConfirm: RANK[level] >= RANK.L2,
    needMfa: level === LEVELS.L3,
    denyCode: null,
    reasons,
  };
}

function deny(code, level, detail) {
  return {
    allowed: false,
    level,
    needConfirm: false,
    needMfa: false,
    denyCode: code,
    reasons: [{ rule: code.toUpperCase().replace(/_/g, '-'), detail }],
  };
}

/** 工具层必须再判一次：即使对话层说“已确认”，这里也重新计算 */
export function assertToolLevel(tool) {
  if (!TOOL_LEVEL[tool]) {
    const err = new Error(`工具 ${tool} 未登记权限级别`);
    err.code = 'UNKNOWN_TOOL';
    throw err;
  }
  return TOOL_LEVEL[tool];
}
