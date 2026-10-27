/**
 * Agent 主循环：确定性状态机。
 * 状态迁移：RECEIVED → GUARDED → PARSED → PLANNED → RISKED → AWAITING_CONFIRM → EXECUTED
 * 任何一步失败都落到 REJECTED / CLARIFY / BLOCKED，绝不“先执行再说”。
 */

import { randomUUID, randomInt } from 'node:crypto';
import { inspectInput, wrapUntrusted } from '../core/guard.mjs';
import { assessRisk, LEVEL } from '../core/risk.mjs';
import { authorize } from '../core/permissions.mjs';
import { formatCents } from '../core/money.mjs';
import { parse, INTENT } from './parser.mjs';

const CONFIRM_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;

export class BankAgent {
  constructor({ db, audit, registry, llm = null }) {
    this.db = db;
    this.audit = audit;
    this.registry = registry;
    this.llm = llm;
    /** @type {Map<string, any>} */
    this.sessions = new Map();
  }

  trace(prefix = 'tr') {
    return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  /**
   * 处理一条用户消息。
   * @param {{userId:string, text:string, channel?:string, newDevice?:boolean, traceId?:string}} p
   */
  async handle({ userId, text, channel = 'web', newDevice = false, traceId }) {
    const traceId2 = traceId ?? this.trace();
    const actor = this.db.getUser(userId);
    if (!actor) {
      return this.finalize(traceId2, {
        status: 'error',
        level: LEVEL.RED,
        reply: '未找到该用户，请重新登录。',
        rules: [{ rule: 'AUTH-UNKNOWN-USER', detail: `用户 ${userId} 不存在` }],
      });
    }

    this.audit.append({
      traceId: traceId2,
      actor: userId,
      event: 'input.received',
      detail: { channel, text: scrub(text).slice(0, 200), length: String(text).length },
    });

    // 1) 护栏
    const guard = inspectInput(text);
    if (guard.blocked) {
      this.audit.append({
        traceId: traceId2,
        actor: userId,
        event: 'guard.blocked',
        level: LEVEL.RED,
        detail: { rules: guard.reasons },
      });
      const s = this.sessions.get(userId);
      if (s) s.pendingParse = null;
      return this.finalize(traceId2, {
        status: 'blocked',
        level: LEVEL.RED,
        reply: `这条消息没有执行。检测到疑似指令注入（${guard.reasons.map((r) => r.rule).join('、')}）。业务请求请用正常表述，我不会因为消息里的“指令”改变安全规则。`,
        rules: guard.reasons.map((r) => ({ rule: r.rule, detail: r.detail })),
      });
    }

    const session = this.sessions.get(userId) ?? {};
    this.sessions.set(userId, session);

    // 2) 解析
    const parsed = await this.parseIntent(guard.normalized, session);
    this.audit.append({
      traceId: traceId2,
      actor: userId,
      event: 'intent.parsed',
      detail: { intent: parsed.intent, confidence: parsed.confidence, missing: parsed.missing, reason: parsed.reason },
    });

    if (parsed.intent === INTENT.REJECTED) {
      return this.finalize(traceId2, {
        status: 'rejected',
        level: LEVEL.YELLOW,
        reply: parsed.explain,
        rules: [{ rule: 'POLICY-MEMO-TRANSFER', detail: parsed.explain }],
      });
    }

    if (parsed.missing?.length) {
      // 缺金额时记住上下文，下一轮补全
      session.pendingParse =
        parsed.intent === INTENT.TRANSFER && parsed.slots?.payee
          ? { intent: INTENT.TRANSFER, slots: { payee: parsed.slots.payee, memo: parsed.slots.memo } }
          : null;
      return this.finalize(traceId2, {
        status: 'clarify',
        level: LEVEL.GREEN,
        reply: this.clarifyText(parsed),
        rules: [],
        clarification: { intent: parsed.intent, missing: parsed.missing },
      });
    }

    session.pendingParse = null;

    // 3) 组装计划并判定
    const plan = this.buildPlan(parsed);
    if (!plan) {
      return this.finalize(traceId2, {
        status: 'clarify',
        level: LEVEL.GREEN,
        reply: '这个请求我还处理不了，已记录。可以试试“查余额”“分析本月账单”“转给王小明 500 元”。',
        rules: [],
      });
    }

    return this.evaluateAndRun({ traceId: traceId2, userId, parsed, plan, session, newDevice, channel });
  }

  /** 确认执行（L2/L3 的第二步） */
  confirm({ userId, token, mfaCode = null, traceId }) {
    const traceId2 = traceId ?? this.trace();
    const session = this.sessions.get(userId);
    const pending = session?.pendingConfirm;
    if (!pending) {
      return this.finalize(traceId2, { status: 'error', level: LEVEL.YELLOW, reply: '没有待确认的操作，可能已过期。', rules: [] });
    }
    if (pending.token !== token) {
      pending.attempts += 1;
      this.audit.append({ traceId: traceId2, actor: userId, event: 'confirm.token_mismatch', level: LEVEL.RED, detail: { attempts: pending.attempts } });
      if (pending.attempts >= 3) session.pendingConfirm = null;
      return this.finalize(traceId2, { status: 'error', level: LEVEL.RED, reply: '确认令牌不匹配，操作未执行。', rules: [] });
    }
    if (Date.now() > pending.expiresAt) {
      session.pendingConfirm = null;
      return this.finalize(traceId2, { status: 'error', level: LEVEL.YELLOW, reply: '确认超时，操作未执行。请重新发起。', rules: [] });
    }
    if (pending.mfaRequired) {
      if (String(mfaCode ?? '') !== pending.mfaCode) {
        pending.attempts += 1;
        this.audit.append({ traceId: traceId2, actor: userId, event: 'confirm.mfa_failed', level: LEVEL.RED, detail: { attempts: pending.attempts } });
        if (pending.attempts >= 3) {
          session.pendingConfirm = null;
          return this.finalize(traceId2, {
            status: 'error',
            level: LEVEL.RED,
            reply: '验证码连续 3 次错误，操作已取消并记录。',
            rules: [{ rule: 'MFA-LOCKOUT', detail: '连续 3 次验证码错误' }],
          });
        }
        return this.finalize(traceId2, {
          status: 'need_confirm',
          level: LEVEL.YELLOW,
          reply: `验证码不正确（第 ${pending.attempts}/3 次），操作未执行。`,
          rules: [],
          confirm: this.publicConfirm(pending),
        });
      }
    }

    session.pendingConfirm = null;
    this.audit.append({ traceId: traceId2, actor: userId, event: 'confirm.accepted', detail: { tool: pending.plan.tool, level: pending.authz.level } });

    const result = this.registry.execute(pending.plan.tool, pending.plan.args, {
      actor: this.db.getUser(userId),
      traceId: pending.traceId,
      stepId: pending.plan.stepId,
      confirmed: true,
      mfaVerified: true,
      newDevice: pending.newDevice,
      dailySpentCents: pending.dailySpentCents,
    });

    return this.respondFromTool(traceId2, userId, pending.parsed, pending.plan, result, pending.risk, pending.authz);
  }

  cancel({ userId, traceId }) {
    const session = this.sessions.get(userId);
    if (session) session.pendingConfirm = null;
    return this.finalize(traceId ?? this.trace(), {
      status: 'ok',
      level: LEVEL.GREEN,
      reply: '已取消，本次没有执行任何资金操作。',
      rules: [],
    });
  }

  // ---------------- 内部 ----------------

  async parseIntent(text, session) {
    const ctx = { pending: session.pendingParse ?? null };
    const ruleResult = parse(text, ctx);
    // 规则置信度不足且配置了模型时，交给模型补意图；模型只产出结构，不执行
    if (this.llm && ruleResult.confidence < 0.6) {
      try {
        const refined = await this.llm.classifyIntent(text);
        if (refined && refined.confidence > ruleResult.confidence) {
          return { ...refined, slots: { ...ruleResult.slots, ...(refined.slots || {}) }, reason: `${ruleResult.reason}+LLM` };
        }
      } catch (err) {
        // 外部模型失败不阻塞主流程，退回规则结论
      }
    }
    return ruleResult;
  }

  buildPlan(parsed) {
    const s = parsed.slots ?? {};
    switch (parsed.intent) {
      case INTENT.QUERY_BALANCE:
        return { tool: 'query_balance', args: {}, stepId: 's1' };
      case INTENT.LIST_TX:
        return { tool: 'list_transactions', args: { limit: 10 }, stepId: 's1' };
      case INTENT.BILL:
        return { tool: 'bill_analyze', args: { days: s.days ?? 30 }, stepId: 's1' };
      case INTENT.SUB_LIST:
        return { tool: 'subscription_list', args: {}, stepId: 's1' };
      case INTENT.SUB_CANCEL:
        return { tool: 'subscription_cancel', args: { subscriptionId: s.subscriptionId ?? s.merchant ?? '' }, stepId: 's1' };
      case INTENT.TRANSFER:
        return { tool: 'transfer_create', args: { payee: s.payee, amountCents: s.amountCents, memo: s.memo ?? '' }, stepId: 's1' };
      default:
        return null;
    }
  }

  evaluateAndRun({ traceId, userId, parsed, plan, session, newDevice, channel }) {
    const actor = this.db.getUser(userId);
    const args = { ...plan.args };

    // 只读解析收款人，用于“首次收款人”判定；解析不到就追问，不去猜
    let payeeAccountId = null;
    let payeeLabel = args.payee;
    if (plan.tool === 'transfer_create') {
      const matches = this.db.findContact(userId, args.payee ?? '');
      const exact = matches.find((m) => m.name === args.payee || m.alias === args.payee || m.phone === args.payee) ?? (matches.length === 1 ? matches[0] : null);
      if (!exact) {
        if (matches.length > 1) {
          return this.finalize(traceId, {
            status: 'clarify',
            level: LEVEL.GREEN,
            reply: `「${args.payee}」匹配到多个收款人：${matches.map((m) => m.name).join('、')}。请说全名或手机号。`,
            rules: [],
          });
        }
        return this.finalize(traceId, {
          status: 'clarify',
          level: LEVEL.GREEN,
          reply: `通讯录里没有「${args.payee}」。为了防诈骗，只能转给已存在的收款人；请先在通讯录添加，或换个名字。`,
          rules: [{ rule: 'PAYEE-NOT-FOUND', detail: `未匹配到收款人「${args.payee}」` }],
        });
      }
      payeeAccountId = exact.account_id;
      payeeLabel = exact.name;
      args.payee = exact.name;
    }

    // 订阅取消：把“商户名”解析成具体订阅 ID；解析不到就列出来让用户选，不猜
    if (plan.tool === 'subscription_cancel') {
      const subs = this.db.subscriptions(userId).filter((s) => s.status === 'active');
      const key = String(args.subscriptionId ?? '');
      const target =
        subs.find((s) => s.id === key) ??
        subs.find((s) => s.merchant === key || s.merchant.includes(key) || key.includes(s.merchant));
      if (!target) {
        const list = subs.map((s) => `· ${s.merchant}（${formatCents(s.amount_cents)}/月）`).join('\n');
        return this.finalize(traceId, {
          status: 'clarify',
          level: LEVEL.GREEN,
          reply: subs.length ? `没找到「${key}」。当前生效中的订阅：\n${list}` : '当前没有生效中的订阅。',
          rules: [],
        });
      }
      args.subscriptionId = target.id;
      args.__merchant = target.merchant;
    }

    // 解析结果写回计划，确认后执行的是解析过的参数，不是模型/规则的原文
    plan.args = args;

    const riskState = this.buildRiskState(userId, { newDevice, payeeAccountId });
    const risk = assessRisk(
      {
        tool: plan.tool,
        amountCents: args.amountCents ?? 0,
        reversible: this.registry.get(plan.tool)?.reversible !== false,
        payeeFirstTime: plan.tool === 'transfer_create' ? this.db.isFirstTimePayee(payeeAccountId ?? 'EXT_SUSPENSE') : false,
        payeeLabel,
      },
      riskState,
    );

    this.audit.append({
      traceId,
      actor: userId,
      event: 'risk.assessed',
      level: risk.level,
      detail: { tool: plan.tool, level: risk.level, hits: risk.hits },
    });

    if (risk.level === LEVEL.RED) {
      session.pendingConfirm = null;
      return this.finalize(traceId, {
        status: 'blocked',
        level: LEVEL.RED,
        reply: this.redReply(risk),
        rules: risk.hits.map((h) => ({ rule: h.rule, detail: h.detail })),
        risk,
      });
    }

    const authz = authorize({
      actor,
      tool: plan.tool,
      args: { userId, amountCents: args.amountCents ?? 0 },
      ctx: { newDevice, dailySpentCents: riskState.dailySpentCents },
    });

    this.audit.append({
      traceId,
      actor: userId,
      event: 'permission.decided',
      level: authz.level,
      detail: { tool: plan.tool, level: authz.level, needConfirm: authz.needConfirm, needMfa: authz.needMfa, denyCode: authz.denyCode },
    });

    if (!authz.allowed) {
      session.pendingConfirm = null;
      return this.finalize(traceId, {
        status: 'blocked',
        level: LEVEL.RED,
        reply: `权限拒绝：${authz.reasons[0]?.detail ?? authz.denyCode}`,
        rules: authz.reasons.map((r) => ({ rule: r.rule, detail: r.detail })),
        decision: authz,
      });
    }

    // 无需确认：直接执行（L0/L1）
    if (!authz.needConfirm) {
      const result = this.registry.execute(plan.tool, args, {
        actor,
        traceId,
        stepId: plan.stepId,
        confirmed: false,
        newDevice,
        dailySpentCents: riskState.dailySpentCents,
      });
      return this.respondFromTool(traceId, userId, parsed, plan, result, risk, authz);
    }

    // 需要确认：生成一次性令牌；L3 额外生成模拟短信验证码
    const pending = {
      token: randomUUID(),
      traceId,
      plan,
      parsed,
      risk,
      authz,
      newDevice,
      dailySpentCents: riskState.dailySpentCents,
      mfaRequired: authz.needMfa,
      mfaCode: authz.needMfa ? String(randomInt(100000, 1000000)) : null,
      expiresAt: Date.now() + CONFIRM_TTL_MS,
      attempts: 0,
    };
    session.pendingConfirm = pending;

    this.audit.append({
      traceId,
      actor: userId,
      event: 'confirm.requested',
      detail: { tool: plan.tool, level: authz.level, mfaRequired: pending.mfaRequired },
    });

    return this.finalize(traceId, {
      status: 'need_confirm',
      level: risk.level,
      reply: this.confirmReply(pending),
      rules: risk.hits.map((h) => ({ rule: h.rule, detail: h.detail })),
      risk,
      decision: authz,
      confirm: this.publicConfirm(pending),
    });
  }

  respondFromTool(traceId, userId, parsed, plan, result, risk, authz) {
    if (!result.ok) {
      return this.finalize(traceId, {
        status: 'error',
        level: LEVEL.YELLOW,
        reply: `操作没有完成：${result.message}`,
        rules: risk.hits.map((h) => ({ rule: h.rule, detail: h.detail })),
        decision: authz,
      });
    }
    const reply = this.composeReply(plan, result.data, risk);
    this.audit.append({ traceId, actor: userId, event: 'reply.sent', detail: { tool: plan.tool, level: risk.level } });
    return this.finalize(traceId, {
      status: 'ok',
      level: risk.level,
      reply,
      rules: risk.hits.map((h) => ({ rule: h.rule, detail: h.detail })),
      risk,
      decision: authz,
      data: result.data,
    });
  }

  finalize(traceId, payload) {
    return {
      traceId,
      status: payload.status,
      level: payload.level,
      reply: payload.reply,
      rules: payload.rules ?? [],
      risk: payload.risk ?? null,
      decision: payload.decision ?? null,
      confirm: payload.confirm ?? null,
      clarification: payload.clarification ?? null,
      data: payload.data ?? null,
    };
  }

  buildRiskState(userId, { newDevice, payeeAccountId }) {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    return {
      dailySpentCents: this.db.dailySpentCents(userId, startOfDay.toISOString()),
      count10m: this.db.countTransfers(userId, new Date(now.getTime() - 10 * 60_000).toISOString()),
      count24h: this.db.countTransfers(userId, new Date(now.getTime() - DAY_MS).toISOString()),
      newDevice,
      payeeAccountId,
    };
  }

  publicConfirm(pending) {
    return {
      token: pending.token,
      tool: pending.plan.tool,
      level: pending.authz.level,
      mfaRequired: pending.mfaRequired,
      // 演示用：真实环境由短信/人脸通道下发，这里显式标注是模拟，不冒充真实认证
      demoMfaCode: pending.mfaRequired ? pending.mfaCode : null,
      summary: summarize(pending.plan),
      expiresInSec: Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000)),
      reason: pending.risk.hits.map((h) => ({ rule: h.rule, detail: h.detail })),
    };
  }

  clarifyText(parsed) {
    const missing = parsed.missing ?? [];
    if (missing.includes('schedule_unsupported')) return '定时转账暂未开放，我可以先做一笔立即转账，要改成立即吗？';
    if (missing.includes('payee') && missing.includes('amount')) return '请补充收款人和金额，例如：转给王小明 500 元。';
    if (missing.includes('payee')) return '请告诉我要转给谁（通讯录里的姓名或手机号）。';
    if (missing.includes('amount')) return '请补充金额，例如 500 元。';
    if (missing.includes('subscriptionId')) return '请告诉我要取消哪一项订阅，例如“取消某某视频会员”。';
    return '我没太理解，可以换个说法吗？';
  }

  redReply(risk) {
    const lines = risk.hits.map((h) => `· ${h.rule}：${h.detail}`).join('\n');
    return `这笔操作没有执行。判定为红色。\n${lines}\n如需大额操作，请走柜面或人工客服复核。`;
  }

  confirmReply(pending) {
    const lines = pending.risk.hits.map((h) => `· ${h.rule}：${h.detail}`).join('\n');
    const mfa = pending.mfaRequired ? `\n需要 L3 多因子认证。演示验证码：${pending.mfaCode}（真实环境经短信下发）` : '';
    return `请确认以下操作：\n${summarize(pending.plan)}\n判定：${levelName(pending.risk.level)}\n${lines}${mfa}\n回复“确认”并输入验证码即可执行，5 分钟内有效。`;
  }

  composeReply(plan, data, risk) {
    const lv = levelName(risk.level);
    const head = risk.hits.length ? `判定：${lv} · ${risk.hits[0].rule}\n· ${risk.hits[0].detail}` : `判定：${lv}，未命中风险规则`;

    switch (plan.tool) {
      case 'query_balance':
        return `你的活期账户余额为 ${data.balanceText}。\n${head}`;
      case 'bill_analyze': {
        if (data.count === 0) return `近 ${data.days} 天没有消费记录。\n${head}`;
        const top = data.categories.slice(0, 3).map((c) => `${c.category} ${c.totalText}（${(c.shareBp / 100).toFixed(1)}%）`).join('，');
        const anomaly = data.anomalies.length ? `\n异常交易 ${data.anomalies.length} 笔，最大一笔 ${data.anomalies[0].merchant} ${data.anomalies[0].amountText}。` : '\n未发现明显异常交易。';
        return `近 ${data.days} 天共 ${data.count} 笔消费，合计 ${data.totalText}。\n主要支出：${top}。${anomaly}\n${head}`;
      }
      case 'subscription_list': {
        const active = data.items.filter((i) => i.status === 'active');
        const list = active.map((i) => `${i.merchant} ${i.amountText}/${i.cycle === 'monthly' ? '月' : i.cycle}`).join('；');
        return `你有 ${active.length} 项生效中的订阅：${list || '无'}。\n${head}`;
      }
      case 'subscription_cancel':
        return `${data.alreadyCancelled ? '该订阅此前已取消' : '已取消'}：${data.merchant}（${data.amountText}）。\n${head}`;
      case 'transfer_create':
        return `已向${data.payeeName}（${data.payeeMasked ?? '外部账户'}）转账 ${data.amountText}${data.memo ? `，备注「${data.memo}」` : ''}。\n交易号 ${data.txnId}，当前余额 ${data.balanceAfterText}。\n${head}`;
      default:
        return `${JSON.stringify(data)}\n${head}`;
    }
  }
}

function summarize(plan) {
  if (plan.tool === 'transfer_create') {
    return `转账 ${formatCents(plan.args.amountCents ?? 0)} 给 ${plan.args.payee}${plan.args.memo ? `（备注：${plan.args.memo}）` : ''}`;
  }
  if (plan.tool === 'subscription_cancel') return `取消订阅 ${plan.args.subscriptionId}`;
  return `执行 ${plan.tool}`;
}

function levelName(level) {
  return level === LEVEL.RED ? '红色' : level === LEVEL.YELLOW ? '黄色' : '绿色';
}

function withLevel(confirm, level) {
  return { ...confirm, riskLevel: level };
}

function scrub(text) {
  return String(text)
    .replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(-2)}`)
    .replace(/\b\d{17}[\dXx]\b/g, '[身份证已脱敏]');
}

export { wrapUntrusted };
