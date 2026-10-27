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
  FX: 'fx_quote',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
});

const PHONE = /^1[3-9]\d{9}$/;

/** 从文本里抽金额，返回 {cents, raw} 或 null。只认明确写法，不猜孤立数字。 */
export function extractAmount(text) {
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

  if (/(订阅|自动续费|代扣|会员)/.test(text) && !/(取消|解约|退订)/.test(text)) {
    return { intent: INTENT.SUB_LIST, confidence: 0.88, slots: {}, missing: [], reason: 'SUB_LIST' };
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

function looksLikeOtherIntent(text) {
  return /(余额|账单|订阅|取消|汇率|美元)/.test(text);
}

/** 判断整句是否“只有金额”，用于多轮补全 */
function isAmountOnlyText(text, rawAmount) {
  const stripped = text.replace(rawAmount, '').replace(/[，,。！!？?\s]/g, '');
  return stripped === '' || /^(就是|是|改成|那就|的话|吧|元|块)+$/.test(stripped);
}

export { INTENT };
