/**
 * 三色判定：纯函数，只读传入的快照，不碰数据库、不改任何状态。
 *
 * 四个维度、九条规则，每条都有独立 rule 名与带具体金额/次数的 detail：
 *   金额（单笔）  R-AMT-SINGLE-WARN / R-AMT-SINGLE-BLOCK
 *   金额（日累计）R-AMT-DAILY-WARN  / R-AMT-DAILY-BLOCK
 *   收款人         R-PAYEE-FIRST-WARN / R-PAYEE-FIRST-BLOCK
 *   可逆性         R-IRREVERSIBLE
 *   频次           R-FREQ-10M-WARN   / R-FREQ-24H-BLOCK
 *   终端           R-DEVICE-NEW
 *
 * 颜色由规则最高严重度决定：red > yellow > green。
 */

export const LEVEL = Object.freeze({ GREEN: 'green', YELLOW: 'yellow', RED: 'red' });

export const DEFAULT_THRESHOLDS = Object.freeze({
  singleWarnCents: 500_000, // ¥5,000
  singleBlockCents: 5_000_000, // ¥50,000
  dailyWarnCents: 1_000_000, // ¥10,000
  dailyBlockCents: 2_000_000, // ¥20,000
  firstPayeeWarnCents: 100_000, // ¥1,000
  firstPayeeBlockCents: 2_000_000, // ¥20,000
  freq10mWarn: 3, // 10 分钟内第 4 笔起
  freq24hBlock: 5, // 24 小时内第 6 笔起
});

const SEVERITY = { green: 0, yellow: 1, red: 2 };

function yuan(cents) {
  const abs = Math.abs(cents);
  return `¥${Math.trunc(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * @param {object} input  本次操作
 * @param {string} input.tool
 * @param {number} input.amountCents       整数分
 * @param {boolean} input.reversible       资金是否可原路退回
 * @param {boolean} [input.payeeFirstTime] 收款人是否首次
 * @param {string}  [input.payeeLabel]     收款人展示名（写进 detail）
 * @param {object} state  只读快照
 * @param {number} state.dailySpentCents   当日已发生转出（不含本笔）
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

  const push = (severity, rule, detail) => hits.push({ severity, rule, detail });

  // ---- 金额：单笔 ----
  if (amount >= t.singleBlockCents) {
    push(
      LEVEL.RED,
      'R-AMT-SINGLE-BLOCK',
      `单笔 ${yuan(amount)} 达到大额红线 ${yuan(t.singleBlockCents)}，须人工复核`,
    );
  } else if (amount >= t.singleWarnCents) {
    push(
      LEVEL.YELLOW,
      'R-AMT-SINGLE-WARN',
      `单笔 ${yuan(amount)} 达到中额阈值 ${yuan(t.singleWarnCents)}，需二次确认`,
    );
  }

  // ---- 金额：日累计 ----
  if (dailyAfter > t.dailyBlockCents) {
    push(
      LEVEL.RED,
      'R-AMT-DAILY-BLOCK',
      `当日已转出 ${yuan(dailyBefore)}，加本笔共 ${yuan(dailyAfter)}，超过日累计上限 ${yuan(t.dailyBlockCents)}`,
    );
  } else if (dailyAfter > t.dailyWarnCents) {
    push(
      LEVEL.YELLOW,
      'R-AMT-DAILY-WARN',
      `当日已转出 ${yuan(dailyBefore)}，加本笔共 ${yuan(dailyAfter)}，超过日累计提示线 ${yuan(t.dailyWarnCents)}`,
    );
  }

  // ---- 收款人：是否首次 ----
  if (first) {
    if (amount >= t.firstPayeeBlockCents) {
      push(
        LEVEL.RED,
        'R-PAYEE-FIRST-BLOCK',
        `首次向${payee}付款且金额 ${yuan(amount)} 达到 ${yuan(t.firstPayeeBlockCents)}，新收款人大额一律拦截`,
      );
    } else if (amount >= t.firstPayeeWarnCents) {
      push(
        LEVEL.YELLOW,
        'R-PAYEE-FIRST-WARN',
        `首次向${payee}付款 ${yuan(amount)}，超过新收款人提示线 ${yuan(t.firstPayeeWarnCents)}`,
      );
    }
  }

  // ---- 可逆性 ----
  if (input.reversible === false && amount > 0) {
    push(
      LEVEL.YELLOW,
      'R-IRREVERSIBLE',
      `该操作不可由用户自助撤销（${input.tool} ${yuan(amount)}），需确认后执行`,
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
      `24 小时内第 ${count24h + 1} 笔转出，超过 ${t.freq24hBlock} 笔上限，须人工复核`,
    );
  }

  // ---- 终端 ----
  if (state.newDevice && input.amountCents > 0) {
    push(
      LEVEL.YELLOW,
      'R-DEVICE-NEW',
      `本次为新设备（登录 2 小时内），涉及资金 ${yuan(amount)} 按高风险处理`,
    );
  }

  hits.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.rule.localeCompare(b.rule));
  const level = hits.reduce((acc, h) => (SEVERITY[h.severity] > SEVERITY[acc] ? h.severity : acc), LEVEL.GREEN);

  return {
    level,
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
