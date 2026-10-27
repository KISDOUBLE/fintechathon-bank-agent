/**
 * 输入护栏：归一化 + 注入检测。
 * 原则：这里只做“清洗与标记”，不做业务判定；业务判定在 risk/permissions。
 *
 * 归一化处理三类绕过：
 *  1. 全角（ＡＢＣ１２３）—— NFKC 统一
 *  2. 零宽（U+200B..U+200F / U+2060 / U+FEFF / 软连字符）
 *  3. 变体选择符与装饰性组合符
 */

const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u180E]/g;
const VARIATION_SELECTORS = /[\uFE00-\uFE0F]/g;
// 组合用附加符号：保留中文声调等常见场景，只清掉连续 2 个以上的异常装饰
const DECORATIVE_COMBINING = /([\u0300-\u036F])\1{1,}/g;

export function normalizeText(input) {
  let s = String(input ?? '');
  s = s.normalize('NFKC'); // 全角 → 半角，凯尔文符号等兼容字符 → 常规
  s = s.replace(ZERO_WIDTH, '');
  s = s.replace(VARIATION_SELECTORS, '');
  s = s.replace(DECORATIVE_COMBINING, '');
  s = s.replace(/\r\n?/g, '\n');
  // 中文之间被拆开的空格（“忽 略 指 令”）合并，防止用空格绕过匹配
  s = s.replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1');
  return s.trim();
}

/** 检测“看起来像被编码过”的片段：连续 base64 / 十六进制长串 */
function looksEncoded(text) {
  const b64 = /[A-Za-z0-9+/]{40,}={0,2}/;
  const hex = /(?:0x)?[0-9a-fA-F]{48,}/;
  return b64.test(text) || hex.test(text);
}

const RULES = [
  {
    id: 'G-IGNORE-INSTRUCTION',
    weight: 3,
    test: /(忽略|无视|跳过|忘记|绕过).{0,8}(之前|以上|上面|前面|所有|全部|你的|先前).{0,8}(指令|规则|提示|限制|要求|设定)/,
  },
  {
    id: 'G-IGNORE-INSTRUCTION-EN',
    weight: 3,
    test: /ignore\s+(all\s+)?(the\s+)?(previous|above|prior|system)\s+(instructions?|rules?|prompts?)/i,
  },
  {
    id: 'G-SYSTEM-PROMPT-LEAK',
    weight: 3,
    test: /(系统提示词?|system\s*prompt|初始指令|开发者模式|developer\s*mode|你的设定|你的系统指令)/i,
  },
  {
    id: 'G-ROLE-OVERRIDE',
    weight: 2,
    test: /(你现在是|从现在起你是|假装你是|扮演|you\s+are\s+now|act\s+as\s+an?\s+(admin|root))/i,
  },
  {
    id: 'G-AUTHORITY-CLAIM',
    weight: 2,
    test: /(我是|我是你).{0,6}(管理员|老板|行长|主管|风控|客服)|(管理员|行长|主管).{0,8}(授权|批准|命令|要求你)/,
  },
  {
    id: 'G-EXFILTRATE',
    weight: 3,
    test: /(列出|导出|给我|打印|发我).{0,10}(所有|全部|其他|别的).{0,10}(客户|用户|账户|身份证|手机号|卡号|密码)/,
  },
  {
    // 反向语序也要拦：“把全部客户的身份证列出来”
    id: 'G-EXFILTRATE-REVERSED',
    weight: 3,
    test: /(所有|全部|其他|别的).{0,10}(客户|用户|账户|身份证|手机号|卡号|密码).{0,12}(列出|导出|给我|打印|发我|列出来)/,
  },
  {
    // 明确要求跳过确认：单独一条即拦截
    id: 'G-BYPASS-CONFIRM',
    weight: 3,
    test: /(别问|不要问|不许问|不用确认|不要确认|无需确认|免确认|不用验证)/,
  },
  {
    id: 'G-URGENCY',
    weight: 2,
    test: /(赶紧|立刻|马上|救命|住院|急救|着急).{0,10}(转|汇款|打款|付款)/,
  },
  {
    id: 'G-MEMO-INJECTION',
    weight: 3,
    test: /(转账后|付款后|执行后|完成后).{0,12}(忽略|删除|修改|再把|转给|汇给)/,
  },
  {
    id: 'G-TOOL-SMUGGLE',
    weight: 3,
    test: /(调用|执行).{0,8}(工具|函数|接口|mcp).{0,8}(转账|付款|导出|删除)/i,
  },
];

/**
 * 检测注入。返回 { blocked, reasons: [{rule, detail}], normalized }。
 * 命中任一 weight>=3 的规则即只读降级（blocked=true）。
 */
export function inspectInput(rawText) {
  const normalized = normalizeText(rawText);
  const reasons = [];

  for (const rule of RULES) {
    const m = normalized.match(rule.test);
    if (m) {
      reasons.push({
        rule: rule.id,
        weight: rule.weight,
        detail: `命中「${truncate(m[0], 40)}」`,
      });
    }
  }

  if (looksEncoded(normalized)) {
    reasons.push({
      rule: 'G-ENCODED-PAYLOAD',
      weight: 1,
      detail: '正文含长串疑似编码内容（base64/hex），已标记待人工复核',
    });
  }

  // 单条高危即拦截；两条及以上中危组合（如“冒充管理员”+“催办不许确认”）同样拦截
  const high = reasons.filter((r) => r.weight >= 3).length;
  const medium = reasons.filter((r) => r.weight === 2).length;
  const blocked = high > 0 || medium >= 2;
  return { blocked, reasons, normalized };
}

function truncate(s, n) {
  const t = s.replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 工具返回值一律视为不可信数据。
 * 不拼进系统提示词，只在数据通道里传递，并加显式不可信包裹。
 */
export function wrapUntrusted(value) {
  const json = JSON.stringify(value ?? null);
  return `<untrusted source="tool_result">${json}</untrusted>`;
}

/** 供 groundedness 检查：从工具结果中收集所有整数分金额与可核对数字 */
export function collectGroundedNumbers(toolResults) {
  const out = new Set();
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number' && Number.isFinite(v)) out.add(String(v));
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0]);
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  toolResults.forEach(walk);
  return out;
}

/**
 * 幻觉防护：回复里出现的每个金额，必须能在工具返回值里找到。
 * 只校验金额，避免把普通数字误判。
 */
export function checkGroundedness(replyText, toolResults) {
  const grounded = collectGroundedNumbers(toolResults);
  const groundedCents = new Set();
  for (const g of grounded) {
    const n = Number(g);
    if (Number.isFinite(n)) {
      groundedCents.add(String(Math.round(n)));
      groundedCents.add(String(Math.round(n * 100)));
    }
  }
  const violations = [];
  for (const m of String(replyText).matchAll(/[¥￥]\s?([\d,]+(?:\.\d{1,2})?)/g)) {
    const raw = m[1].replace(/,/g, '');
    const cents = /\.\d/.test(raw)
      ? Math.round(Number(raw) * 100)
      : Math.round(Number(raw) * 100);
    if (!groundedCents.has(String(cents))) {
      violations.push({ text: m[0], cents });
    }
  }
  return { ok: violations.length === 0, violations };
}
