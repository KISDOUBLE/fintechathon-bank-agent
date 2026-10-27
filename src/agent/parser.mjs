/**
 * 意图解析：规则优先，覆盖口语化、省略与多轮补全。
 * 每个结果都带 confidence 与 missing，置信度低就走追问，不猜。
 */

import { parseAmountToCents } from '../core/money.mjs';
import { normalizeText } from '../core/guard.mjs';

const INTENT = Object.freeze({
  QUERY_BALANCE: 'query_balance',
  LIST_TX: 'list_transactions',
  TRANSFER: 'transfer',
  BILL: 'bill_analyze',
  SUB_LIST: 'subscription_list',
  SUB_CANCEL: 'subscription_cancel',
  SUB_CANCEL_ALL: 'subscription_cancel_all',
  FX: 'fx_quote',
  WEALTH_LIST: 'wealth_list',
  WEALTH_RECOMMEND: 'wealth_recommend',
  WEALTH_BUY: 'wealth_subscribe',
  WEALTH_REDEEM: 'wealth_redeem',
  CARD_LIST: 'card_list',
  CARD_APPLY: 'card_apply',
  CARD_LIMIT: 'card_set_limit',
  CARD_FREEZE: 'card_freeze',
  CARD_UNFREEZE: 'card_unfreeze',
  TRANSFER_SCHEDULE: 'transfer_schedule_create',
  SCHEDULE_LIST: 'transfer_schedule_list',
  SCHEDULE_CANCEL: 'transfer_schedule_cancel',
  TRANSFER_SPLIT: 'transfer_split',
  SUB_DETECT: 'subscription_detect',
  BIRTHDAY: 'birthday_setup',
  EVENT_LIST: 'event_list',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
});

const PHONE = /^1[3-9]\d{9}$/;

/** 从文本里抽金额，返回 {cents, raw} 或 null。只认明确写法，不猜孤立数字。 */
export function extractAmount(text) {
  // 负数金额不是“金额缺失”，是错误输入：直接拒绝，绝不能当成正数
  if (/(?:^|[\s，,：:])\s*-\s*[0-9零〇一二两三四五六七八九十百千万]/.test(text)) return null;

  // 1) 阿拉伯数字 + 可选万/千 + 货币单位
  let m = text.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(万|千|百)?\s*(?:元|块|圆|人民币|rmb)/i);
  if (m) {
    const cents = parseAmountToCents(m[2] ? `${m[1]}${m[2]}` : m[1]);
    if (cents && cents > 0) return { cents, raw: m[0] };
  }
  // 2) 阿拉伯数字 + 数量级（无货币单位）：1.5万
  m = text.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(万|千)(?![0-9])/);
  if (m) {
    const cents = parseAmountToCents(`${m[1]}${m[2]}`);
    if (cents && cents > 0) return { cents, raw: m[0] };
  }
  // 3) 中文数字 + 货币单位：五千块
  m = text.match(/([零〇一二两三四五六七八九十百千万亿]+)\s*(?:元|块|圆)/);
  if (m) {
    const cents = parseAmountToCents(m[1]);
    if (cents && cents > 0) return { cents, raw: m[0] };
  }
  // 4) 孤立数字（1–7 位，排除手机号/卡号），且不是日期
  const bare = [...text.matchAll(/(?:^|[\s，,：:给转])([0-9][0-9,]{0,6})(?=$|[\s，,。！!？?])/g)];
  for (const b of bare) {
    if (PHONE.test(b[1])) continue;
    const cents = parseAmountToCents(b[1]);
    if (cents && cents > 0) return { cents, raw: b[0].trim() };
  }
  return null;
}

/** 抽收款人：支持“转给小王”“给小王转”“转给13800000003” */
export function extractPayee(text) {
  const cleaned = text.replace(/[0-9][0-9,]*(?:\.[0-9]{1,2})?\s*(?:万|千|百)?\s*(?:元|块|圆|人民币|rmb)/gi, ' ');

  let m = cleaned.match(/转给\s*([^\s，,。！!？?]+)/);
  if (m) return cleanPayee(m[1]);

  m = cleaned.match(/给\s*([^\s，,。！!？?]+?)\s*(?:转|汇款|打款|打钱)/);
  if (m) return cleanPayee(m[1]);

  m = cleaned.match(/(?:转|汇|打)\s*[0-9]+\s*(?:元|块)?\s*给\s*([^\s，,。！!？?]+)/);
  if (m) return cleanPayee(m[1]);

  m = cleaned.match(/(?:向|给)\s*([^\s，,。！!？?]{1,12})\s*(?:转|汇款|打款)/);
  if (m) return cleanPayee(m[1]);

  return null;
}

function cleanPayee(s) {
  let p = String(s).trim();
  // 去掉尾部残留的动词/助词
  p = p.replace(/(吧|啊|呀|哦|呢|，|,)+$/g, '');
  p = p.replace(/^(一下|一笔|点)/, '');
  return p || null;
}

export function extractMemo(text) {
  const m = text.match(/(?:备注|用途|写着)[是为:：]?\s*([^\n。！!？?]{1,40})/);
  return m ? m[1].trim() : null;
}

/**
 * @param {string} rawText
 * @param {{pending?: {intent:string, slots:object}|null}} [ctx]
 */
export function parse(rawText, ctx = {}) {
  const text = normalizeText(rawText);

  // 策略性拒绝：按备注/按用途匹配收款人，无法核验收款人身份，一律拒绝
  if (/(按|凭|根据).{0,4}备注.{0,6}(转|打款|汇款|付款)/.test(text)) {
    return {
      intent: INTENT.REJECTED,
      confidence: 1,
      slots: {},
      missing: [],
      reason: 'POLICY_MEMO_TRANSFER',
      explain: '不支持按备注匹配收款人：备注是用户自由文本，可被伪造，不能作为身份依据。请提供姓名或手机号。',
    };
  }

  const amount = extractAmount(text);

  // 多轮补金额：上一轮在等金额，本轮只给数字
  if (ctx.pending?.intent === INTENT.TRANSFER && ctx.pending.slots?.payee && !looksLikeOtherIntent(text)) {
    if (amount && isAmountOnlyText(text, amount.raw)) {
      return {
        intent: INTENT.TRANSFER,
        confidence: 0.95,
        slots: { ...ctx.pending.slots, amountCents: amount.cents },
        missing: [],
        reason: 'MULTI_TURN_AMOUNT_FILL',
      };
    }
  }

  // 订阅识别要早于订阅列表：“有哪些订阅在扣费”是识别请求，不是列清单
  if (/(扣费|扣款|自动续费|自动扣)/.test(text) && /(哪些|识别|有没有|看看|检测|发现)/.test(text) && !/(取消|解约|退订)/.test(text)) {
    return { intent: INTENT.SUB_DETECT, confidence: 0.9, slots: {}, missing: [], reason: 'SUB_DETECT' };
  }

  // 批量取消要先于单条取消判断：“全部/所有/都”是范围词
  if (
    /(所有|全部|都|全|每一?项|统统|挨个)/.test(text) &&
    /(订阅|自动续费|自动扣费|扣费|续费|代扣|会员)/.test(text) &&
    /(取消|关掉|停掉|解约|退订|退了|关了)/.test(text)
  ) {
    return {
      intent: INTENT.SUB_CANCEL_ALL,
      confidence: 0.9,
      slots: {},
      missing: [],
      reason: 'SUB_CANCEL_ALL',
    };
  }

  // “取消云音乐黑胶”这类动词开头的说法：商户名任意，但排除资金类动词
  if (/^(取消|退订|解约|关掉|关闭)/.test(text) && !/(转账|汇款|打款|付款|订单|账单|支付)/.test(text)) {
    const merchant = text
      .replace(/^(取消|退订|解约|关掉|关闭)/, '')
      .replace(/(的)?(订阅|会员|自动续费|代扣)$/, '')
      .trim();
    return {
      intent: INTENT.SUB_CANCEL,
      confidence: merchant ? 0.82 : 0.7,
      slots: { merchant: merchant || null },
      missing: merchant ? [] : ['subscriptionId'],
      reason: 'SUB_CANCEL_VERB_FIRST',
    };
  }

  if (/(取消|解约|退订).{0,6}(订阅|会员|自动续费|代扣)/.test(text) || /(订阅|会员).{0,6}(取消|解约|退订)/.test(text)) {
    const merchant = text.match(/(?:取消|解约|退订)\s*([^\s，,。]{2,16}?)(?:的)?(?:订阅|会员|自动续费|代扣)?$/)?.[1] ?? null;
    return {
      intent: INTENT.SUB_CANCEL,
      confidence: 0.9,
      slots: { merchant },
      missing: merchant ? [] : ['subscriptionId'],
      reason: 'SUB_CANCEL',
    };
  }

  if (/(订阅|自动续费|自动扣费|扣费|续费|代扣|会员)/.test(text) && !/(取消|解约|退订)/.test(text)) {
    return { intent: INTENT.SUB_LIST, confidence: 0.88, slots: {}, missing: [], reason: 'SUB_LIST' };
  }

  // ---------------- 卡片 ----------------
  if (/(挂失|丢卡|卡丢|卡不见)/.test(text)) {
    return { intent: INTENT.CARD_FREEZE, confidence: 0.92, slots: { mode: 'loss', last4: last4Of(text) }, missing: [], reason: 'CARD_LOSS' };
  }
  if (/(解挂|解锁|解冻|恢复交易|恢复用卡)/.test(text)) {
    return { intent: INTENT.CARD_UNFREEZE, confidence: 0.9, slots: { last4: last4Of(text) }, missing: [], reason: 'CARD_UNFREEZE' };
  }
  if (/(锁卡|冻结|交易限制|限制交易|停用)/.test(text)) {
    return { intent: INTENT.CARD_FREEZE, confidence: 0.88, slots: { mode: 'lock', last4: last4Of(text) }, missing: [], reason: 'CARD_LOCK' };
  }
  if (/(额度|限额)/.test(text) && /(调|改|降|升|设)/.test(text)) {
    return { intent: INTENT.CARD_LIMIT, confidence: 0.9, slots: { last4: last4Of(text), limitCents: amount?.cents ?? null }, missing: amount ? [] : ['limit'], reason: 'CARD_LIMIT' };
  }
  if (/(申请|办|开).{0,4}(卡|虚拟卡)/.test(text)) {
    return { intent: INTENT.CARD_APPLY, confidence: 0.85, slots: {}, missing: [], reason: 'CARD_APPLY' };
  }
  if (/(卡)/.test(text) && /(有哪些|列表|状态|看看|查)/.test(text)) {
    return { intent: INTENT.CARD_LIST, confidence: 0.85, slots: {}, missing: [], reason: 'CARD_LIST' };
  }

  // ---------------- 理财 ----------------
  if (/(赎回|取出)/.test(text) && !/(取款|取现)/.test(text)) {
    return { intent: INTENT.WEALTH_REDEEM, confidence: 0.9, slots: { product: productOf(text) }, missing: [], reason: 'WEALTH_REDEEM' };
  }
  if (/(申购|买入|购买|认购)/.test(text)) {
    return {
      intent: INTENT.WEALTH_BUY,
      confidence: amount ? 0.9 : 0.7,
      slots: { product: productOf(text), amountCents: amount?.cents ?? null },
      missing: amount ? [] : ['amount'],
      reason: 'WEALTH_BUY',
    };
  }
  if (/(推荐|稳健|保本|低风险)/.test(text) && /(理财|基金|产品)/.test(text)) {
    const riskMax = /保本|低风险|稳健/.test(text) ? 2 : 3;
    return { intent: INTENT.WEALTH_RECOMMEND, confidence: 0.88, slots: { riskMax }, missing: [], reason: 'WEALTH_RECOMMEND' };
  }
  if (/(理财|基金|产品)/.test(text)) {
    return { intent: INTENT.WEALTH_LIST, confidence: 0.8, slots: {}, missing: [], reason: 'WEALTH_LIST' };
  }

  // ---------------- 订阅识别 ----------------
  if (/(订阅|扣费|续费)/.test(text) && /(识别|自动|帮我看看|有没有|哪些)/.test(text)) {
    return { intent: INTENT.SUB_DETECT, confidence: 0.88, slots: {}, missing: [], reason: 'SUB_DETECT' };
  }

  // ---------------- 跨场景 ----------------
  if (/生日/.test(text)) {
    const date = parseDate(text);
    const person =
      text.match(/(我爱人|我老婆|我老公|我妈妈|我爸爸|我妈|我爸|女儿|儿子|朋友)/)?.[1] ??
      text.match(/([^\s，,。]{1,3})的生日/)?.[1] ??
      '家人';
    return {
      intent: INTENT.BIRTHDAY,
      confidence: date && amount ? 0.9 : 0.7,
      slots: { person, date, budgetCents: amount?.cents ?? null },
      missing: [!date && 'date', !amount && 'budget'].filter(Boolean),
      reason: 'BIRTHDAY',
    };
  }
  if (/(跨场景|生日安排|我的安排)/.test(text)) {
    return { intent: INTENT.EVENT_LIST, confidence: 0.8, slots: {}, missing: [], reason: 'EVENT_LIST' };
  }

  // ---------------- 定时转账 / AA ----------------
  if (/(取消|撤销|停掉).{0,6}(定时|预约)转账/.test(text)) {
    return { intent: INTENT.SCHEDULE_CANCEL, confidence: 0.9, slots: { id: '' }, missing: [], reason: 'SCHEDULE_CANCEL' };
  }
  if (/(定时转账|预约转账)/.test(text) && /(有哪些|列表|看看|查|我的)/.test(text)) {
    return { intent: INTENT.SCHEDULE_LIST, confidence: 0.88, slots: {}, missing: [], reason: 'SCHEDULE_LIST' };
  }
  if (/(定时|预约|明天|后天|下周|下个月|每月|每周)/.test(text) && /(转|汇款|打款)/.test(text)) {
    const payee = extractPayee(text);
    return {
      intent: INTENT.TRANSFER_SCHEDULE,
      confidence: 0.85,
      slots: { payee, amountCents: amount?.cents ?? null, runAt: parseDate(text) },
      missing: [!payee && 'payee', !amount && 'amount'].filter(Boolean),
      reason: 'TRANSFER_SCHEDULE',
    };
  }
  if (/(AA|平摊|分摊|各付各的)/i.test(text)) {
    const payees = text.match(/(?:和|跟|与)([^\s，,。]{2,30}?)(?:平摊|AA|分摊|各付)/i)?.[1]?.split(/[、,，和跟与]/).map((s) => s.trim()).filter(Boolean) ?? [];
    return {
      intent: INTENT.TRANSFER_SPLIT,
      confidence: payees.length >= 2 && amount ? 0.85 : 0.6,
      slots: { payees, totalCents: amount?.cents ?? null },
      missing: [payees.length < 2 && 'payees', !amount && 'amount'].filter(Boolean),
      reason: 'TRANSFER_SPLIT',
    };
  }

  // 账单必须先于余额：“花了多少钱”不是查余额
  if (/(账单|消费|花了|支出|开销|流水)/.test(text)) {
    const days = /(本月|这个月|这月)/.test(text) ? 30 : /(上周|这周)/.test(text) ? 7 : /(今年|年度)/.test(text) ? 365 : 30;
    return { intent: INTENT.BILL, confidence: 0.9, slots: { days }, missing: [], reason: 'BILL' };
  }

  if (/(余额|还有多少|多少钱|账户里)/.test(text) && !/(转|汇|打款)/.test(text)) {
    return { intent: INTENT.QUERY_BALANCE, confidence: 0.92, slots: {}, missing: [], reason: 'BALANCE' };
  }

  if (/(汇率|美元|美金|人民币|兑换|换汇|usd|cny)/i.test(text)) {
    const foreign = /(美元|美金|usd)/i.test(text) ? 'USD' : /(欧元|eur)/i.test(text) ? 'EUR' : null;
    return {
      intent: INTENT.FX,
      confidence: foreign ? 0.85 : 0.6,
      slots: { from: foreign, to: foreign ? 'CNY' : null, amountCents: amount?.cents ?? null },
      missing: foreign ? [] : ['currency'],
      reason: 'FX',
    };
  }

  if (/(转给|转账|汇款|打款|打钱|给.{1,10}转)/.test(text)) {
    const payee = extractPayee(text);
    const memo = extractMemo(text);
    const missing = [];
    if (!payee) missing.push('payee');
    if (!amount) missing.push('amount');
    if (/(定时|每天|每周|每月|预约)/.test(text)) missing.push('schedule_unsupported');
    return {
      intent: INTENT.TRANSFER,
      confidence: payee && amount ? 0.93 : 0.7,
      slots: { payee, amountCents: amount?.cents ?? null, memo },
      missing,
      reason: 'TRANSFER',
    };
  }

  if (amount && !ctx.pending) {
    return {
      intent: INTENT.UNKNOWN,
      confidence: 0.4,
      slots: { amountCents: amount.cents },
      missing: ['intent'],
      reason: 'AMOUNT_WITHOUT_INTENT',
    };
  }

  return { intent: INTENT.UNKNOWN, confidence: 0.2, slots: {}, missing: ['intent'], reason: 'NO_MATCH' };
}

/** 卡尾号：优先“尾号xxxx”，否则取文中第一组 4 位数字 */
function last4Of(text) {
  return text.match(/尾号\s*(\d{4})/)?.[1] ?? text.match(/(\d{4})/)?.[1] ?? '';
}

/** 产品名：动词后面那一段，或已知产品前缀 */
function productOf(text) {
  return (
    text.match(/(?:申购|买入|购买|赎回|投)\s*([^\s，,。]{2,12})/)?.[1] ??
    text.match(/(稳健|平衡|指数|货币)[^\s，,。]{0,10}/)?.[0] ??
    ''
  );
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 解析日期：YYYY-MM-DD / M月D日 / 下个月D号 / 明天 / 后天 */
export function parseDate(text) {
  let m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  m = text.match(/下个?月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 1);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(m[1])}`;
  }

  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const y = new Date().getUTCFullYear();
    return `${y}-${pad2(m[1])}-${pad2(m[2])}`;
  }

  m = text.match(/(明天|后天)/);
  if (m) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + (m[1] === '明天' ? 1 : 2));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function looksLikeOtherIntent(text) {  return /(余额|账单|订阅|取消|汇率|美元)/.test(text);
}

/** 判断整句是否“只有金额”，用于多轮补全 */
function isAmountOnlyText(text, rawAmount) {
  const stripped = text.replace(rawAmount, '').replace(/[，,。！!？?\s]/g, '');
  return stripped === '' || /^(就是|是|改成|那就|的话|吧|元|块)+$/.test(stripped);
}

export { INTENT };
