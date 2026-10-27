/**
 * 金额一律整数分（integer cents）。本模块是唯一允许把人类输入转成分的地方。
 * 禁止浮点：对外 API 只接受 string / integer cents，收到 number 直接抛错。
 */

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3,
  四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};

const CN_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const BIG_UNITS = { 万: 10000, 亿: 100000000 };

/** 中文数字（整数元）→ 整数。无法解析返回 null。 */
export function cnIntegerToNumber(text) {
  if (!text) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  let sawAny = false;

  for (const ch of text) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
      sawAny = true;
    } else if (ch in CN_UNITS) {
      // “十五”里的“十”前面没有数字，按 1 处理
      section += (number === 0 ? 1 : number) * CN_UNITS[ch];
      number = 0;
      sawAny = true;
    } else if (ch in BIG_UNITS) {
      section += number;
      total += section * BIG_UNITS[ch];
      section = 0;
      number = 0;
      sawAny = true;
    } else {
      return null;
    }
  }
  if (!sawAny) return null;
  return total + section + number;
}

/**
 * 十进制字符串 → 以 10^scale 为单位的 BigInt。
 * 只做字符串运算，不经过 IEEE754。
 * 返回 { value: BigInt, ok: boolean }
 */
function decimalToScaled(text, scale) {
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false };
  const [intPart, fracPart = ''] = text.split('.');
  if (fracPart.length > scale) {
    // 多于 scale 位的小数一律拒绝，避免悄悄四舍五入
    return { ok: false };
  }
  const padded = fracPart.padEnd(scale, '0');
  return { ok: true, value: BigInt(intPart + padded) };
}

const UNIT_SUFFIX = /(元|块|圆|人民币|rmb)$/i;
const CN_NUMERAL_ONLY = /^[零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万卍亿]+$/;

/**
 * 人类金额文本 → 整数分。
 * 支持：5000 / 5,000 / ￥5,000.00 / 五千块 / 5千 / 1.5万 / 五百
 * 无法解析或含非法小数位返回 null。
 */
export function parseAmountToCents(input) {
  if (typeof input === 'number') {
    throw new TypeError('金额禁止使用浮点数；请传字符串或整数分');
  }
  if (input === null || input === undefined) return null;

  let s = String(input).normalize('NFKC').trim();
  if (!s) return null;

  s = s.replace(/[,\s，_]/g, '');
  s = s.replace(/^[¥￥$]/, '');
  s = s.replace(UNIT_SUFFIX, '');
  if (!s) return null;

  // 阿拉伯数字 + 可选小数 + 可选数量级：1.5万 / 5000 / 5千
  const m = s.match(/^(\d+(?:\.\d+)?)(万|亿|千|百)?$/);
  if (m) {
    const [, num, big] = m;
    const multiplier = big === '万' ? 10000 : big === '亿' ? 100000000 : big === '千' ? 1000 : big === '百' ? 100 : 1;
    // 先按“元”算到 1e-6 精度，再乘数量级，最后取分
    const scaled = decimalToScaled(num, 6);
    if (!scaled.ok) return null;
    const yuanMicros = scaled.value * BigInt(multiplier); // 1e-6 元
    const cents = yuanMicros / 10000n; // 1 分 = 1e4 微元
    if (cents * 10000n !== yuanMicros) return null; // 出现不足一分的金额，拒绝
    return Number(cents);
  }

  // 纯中文数字
  if (CN_NUMERAL_ONLY.test(s)) {
    const yuan = cnIntegerToNumber(s);
    if (yuan === null || !Number.isSafeInteger(yuan)) return null;
    return yuan * 100;
  }

  return null;
}

/** 整数分 → 展示字符串，如 500000 → ¥5,000.00 */
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError('formatCents 只接受整数分');
  }
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.trunc(abs / 100);
  const fen = abs % 100;
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}¥${grouped}.${String(fen).padStart(2, '0')}`;
}

/** 整数分 → 纯数字元字符串，供日志/CSV 使用 */
export function centsToYuanString(cents) {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 断言整数分，供工具层入口校验 */
export function assertCents(value, label = 'amount') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    const err = new Error(`${label} 必须是正整数分，收到 ${JSON.stringify(value)}`);
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  return value;
}
