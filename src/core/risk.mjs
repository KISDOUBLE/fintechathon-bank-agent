/**
 * 三色判定：纯函数，只读快照，不碰数据库、不改状态。
 *
 * 颜色语义严格按赛题：
 *   绿色 = 自动执行（纯查询）
 *   黄色 = 用户确认（日累计 ≤ ¥1,000 的转账等）
 *   红色 = 强验证（日累计 > ¥1,000，需多因子后放行）
 *   另外单列「硬拦截」：越限、越权、注入、熔断——这类不给验证机会，直接拒绝。
 *
 * 每条规则都有独立 rule 名与带具体金额/次数的 detail。
 */

export const LEVEL = Object.freeze({ GREEN: 'green', YELLOW: 'yellow', RED: 'red' });

export const DEFAULT_THRESHOLDS = Object.freeze({
  yellowDailyCents: 100_000, // ¥1,000：日累计免强验证额度
  blockDailyCents: 2_000_000, // ¥20,000：日累计硬上限
  blockSingleCents: 5_000_000, // ¥50,000：单笔硬上限
  firstPayeeWarnCents: 50_000, // ¥500：新收款人提示线
  freq10mWarn: 3,
  freq24hBlock: 5,
});

const SEVERITY = { green: 0, yellow: 1, red: 2 };

function yuan(cents) {
  const abs = Math.abs(cents);
  return `¥${Math.trunc(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * @param {object} input
 * @param {string} input.tool
 * @param {number} input.amountCents
 * @param {boolean} input.reversible
 * @param {boolean} [input.payeeFirstTime]
 * @param {string}  [input.payeeLabel]
 * @param {object} state  只读快照
 * @param {number} state.dailySpentCents
 * @param {number} state.count10m
 * @param {number} state.count24h
 * @param {boolean} [state.newDevice]
 * @param {object} [state.thresholds]
 */
export function assessRisk(input, state = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(state.thresholds || {}) };
  const amount = input.amountCents ?? 0;
  const dailyBefore = state.dailySpentCents ?? 0;
  const dailyAfter = dailyBefore + amount;
  const first = Boolean(input.payeeFirstTime);
  const payee = input.payeeLabel || '该收款人';
  const hits = [];
  let block = false;

  const push = (severity, rule, detail, isBlock = false) => {
    hits.push({ severity, rule, detail });
    if (isBlock) block = true;
  };

  // 纯查询：不动钱，直接绿
  if (amount <= 0 && input.reversible !== false) {
    return { level: LEVEL.GREEN, hits, block: false, explain: { head: '纯查询操作，未命中风险规则', rule: 'R-NONE' } };
  }

  // ---- 金额：日累计决定黄/红（赛题口径 ¥1,000）----
  if (amount >= t.blockSingleCents) {
    push(
      LEVEL.RED,
      'R-LIMIT-SINGLE-BLOCK',
      `单笔 ${yuan(amount)} 达到单笔硬上限 ${yuan(t.blockSingleCents)}，超出受理范围，需柜面办理`,
      true,
    );
  } else if (dailyAfter > t.blockDailyCents) {
    push(
      LEVEL.RED,
      'R-LIMIT-DAILY-BLOCK',
      `当日已转出 ${yuan(dailyBefore)}，加本笔共 ${yuan(dailyAfter)}，超过日累计硬上限 ${yuan(t.blockDailyCents)}`,
      true,
    );
  } else if (dailyAfter > t.yellowDailyCents) {
    push(
      LEVEL.RED,
      'R-AMT-RED-VERIFY',
      `当日已转出 ${yuan(dailyBefore)}，加本笔共 ${yuan(dailyAfter)}，超出 ${yuan(t.yellowDailyCents)} 免强验证额度，需多因子认证`,
    );
  } else {
    push(
      LEVEL.YELLOW,
      'R-AMT-YELLOW-CONFIRM',
      `当日已转出 ${yuan(dailyBefore)}，加本笔共 ${yuan(dailyAfter)}，在 ${yuan(t.yellowDailyCents)} 免强验证额度内，二次确认即可`,
    );
  }

  // ---- 收款人：首次 ----
  if (first && amount >= t.firstPayeeWarnCents) {
    push(
      LEVEL.YELLOW,
      'R-PAYEE-FIRST',
      `首次向${payee}付款 ${yuan(amount)}，超过新收款人提示线 ${yuan(t.firstPayeeWarnCents)}`,
    );
  }

  // ---- 可逆性 ----
  if (input.reversible === false) {
    const amountText = amount > 0 ? ` ${yuan(amount)}` : '（无金额变化）';
    push(
      LEVEL.YELLOW,
      'R-IRREVERSIBLE',
      `该操作不可由用户自助撤销（${input.tool}${amountText}），需确认后执行`,
    );
  }

  // ---- 频次 ----
  const count10m = state.count10m ?? 0;
  if (count10m + 1 > t.freq10mWarn) {
    push(
      LEVEL.YELLOW,
      'R-FREQ-10M-WARN',
      `10 分钟内第 ${count10m + 1} 笔操作，超过 ${t.freq10mWarn} 笔阈值`,
    );
  }
  const count24h = state.count24h ?? 0;
  if (count24h + 1 > t.freq24hBlock) {
    push(
      LEVEL.RED,
      'R-FREQ-24H-BLOCK',
      `24 小时内第 ${count24h + 1} 笔转出，超过 ${t.freq24hBlock} 笔上限，触发熔断`,
      true,
    );
  }

  // ---- 终端 ----
  if (state.newDevice && amount > 0) {
    push(
      LEVEL.YELLOW,
      'R-DEVICE-NEW',
      `本次为新设备（登录 2 小时内），涉及资金 ${yuan(amount)}，按高风险处理`,
    );
  }

  hits.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.rule.localeCompare(b.rule));
  const level = hits.reduce((acc, h) => (SEVERITY[h.severity] > SEVERITY[acc] ? h.severity : acc), LEVEL.GREEN);

  return {
    level,
    block,
    hits,
    explain: {
      head: hits.length ? hits[0].detail : '未命中任何风险规则',
      rule: hits.length ? hits[0].rule : 'R-NONE',
    },
  };
}

export function levelToChinese(level) {
  return level === LEVEL.RED ? '红' : level === LEVEL.YELLOW ? '黄' : '绿';
}
