/**
 * DeepSeek（OpenAI 兼容）客户端。
 * 约束：
 *  - 密钥只从环境变量读，绝不落盘/入库/进日志
 *  - 每次请求都有超时，超时按失败处理，不阻塞主流程
 *  - 模型只产出结构（意图/槽位/工具提议），不直接执行资金动作
 */

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash'; // DeepSeek-V4.1-Flash-1017

export function llmConfig(env = process.env) {
  return {
    apiKey: env.DEEPSEEK_API_KEY || env.BANK_LLM_API_KEY || '',
    baseUrl: (env.DEEPSEEK_BASE_URL || env.BANK_LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
    model: env.DEEPSEEK_MODEL || env.BANK_LLM_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 8000),
  };
}

export function createDeepSeekClient(cfg = llmConfig()) {
  if (!cfg.apiKey) {
    throw new Error('缺少模型密钥：请设置 DEEPSEEK_API_KEY（或 BANK_LLM_API_KEY）环境变量');
  }

  async function chat(messages, { tools, temperature = 0, timeoutMs = cfg.timeoutMs, jsonMode = false } = {}) {
    const body = {
      model: cfg.model,
      messages,
      temperature,
      stream: false,
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`模型调用失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.code = res.status === 401 ? 'LLM_AUTH' : 'LLM_HTTP';
      throw err;
    }
    const json = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    return { message: msg, usage: json.usage ?? null, raw: json };
  }

  /** 意图分类：只返回结构，置信度由模型自评，用于规则兜底 */
  async function classifyIntent(text) {
    const sys = '你是银行意图分类器。只输出 JSON，字段：intent(string), confidence(number 0-1), slots(object)。' +
      'intent 只能是 query_balance|list_transactions|transfer|bill_analyze|subscription_list|subscription_cancel|subscription_cancel_all|fx_quote|unknown。' +
      '用户说“所有/全部/都”并涉及订阅时用 subscription_cancel_all。' +
      'transfer 的 slots 字段为 payee(string)、amountCents(integer, 单位分)、memo(string)；memo 只在用户明确说了备注时填写。禁止输出其他内容。';
    const { message } = await chat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: text },
      ],
      { temperature: 0, jsonMode: true },
    );
    let parsed;
    try {
      parsed = JSON.parse(message.content ?? '{}');
    } catch {
      return null;
    }
    const allowed = new Set([
      'query_balance', 'list_transactions', 'transfer', 'bill_analyze',
      'subscription_list', 'subscription_cancel', 'fx_quote', 'unknown',
    ]);
    if (!allowed.has(parsed.intent)) return null;
    const conf = Number(parsed.confidence);
    if (!Number.isFinite(conf)) return null;
    // 金额由模型给出时必须是整数分，浮点一律丢弃
    if (parsed.slots?.amountCents !== undefined && !Number.isSafeInteger(parsed.slots.amountCents)) {
      delete parsed.slots.amountCents;
    }
    return { intent: parsed.intent, confidence: Math.min(Math.max(conf, 0), 1), slots: parsed.slots ?? {}, missing: [] };
  }

  /**
   * 工具调用循环：模型提议、工具层裁决。
   * 返回 { reply, steps:[{tool,args,ok,code}], messages }
   */
  async function runToolLoop({ systemPrompt, userText, toolSchemas, execute, maxTurns = 4, timeoutMs = cfg.timeoutMs }) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ];
    const steps = [];

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const { message } = await chat(messages, { tools: toolSchemas, timeoutMs });
      messages.push(message);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        return { reply: message.content ?? '', steps, messages };
      }
      for (const call of calls) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        const result = execute(call.function?.name, args);
        steps.push({ tool: call.function?.name, args, ok: result.ok, code: result.code ?? null });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.ok ? result.data : { error: result.code, message: result.message }),
        });
      }
    }
    return { reply: '', steps, messages };
  }

  return { chat, classifyIntent, runToolLoop, config: cfg };
}
