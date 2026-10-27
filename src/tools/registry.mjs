/**
 * 工具注册表：所有资金/数据动作的唯一入口。
 *
 * 硬约束：权限在“这里”再判一次，不信任对话层的结论。
 * 即使上层说已确认，缺少 confirmed / mfaVerified 证据仍然拒绝。
 */

import { authorize, TOOL_LEVEL } from '../core/permissions.mjs';
import { canonicalJson } from '../core/audit.mjs';

export class ToolRegistry {
  constructor({ db, audit }) {
    this.db = db;
    this.audit = audit;
    /** @type {Map<string, any>} */
    this.tools = new Map();
  }

  register(spec) {
    if (!spec?.name) throw new Error('工具必须有 name');
    if (this.tools.has(spec.name)) throw new Error(`工具重复注册：${spec.name}`);
    if (!TOOL_LEVEL[spec.name]) throw new Error(`工具 ${spec.name} 未在权限矩阵登记`);
    this.tools.set(spec.name, spec);
    return this;
  }

  get(name) {
    return this.tools.get(name) ?? null;
  }

  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      level: TOOL_LEVEL[t.name],
      reversible: t.reversible,
      description: t.description,
    }));
  }

  /**
   * 执行工具。
   * @param {string} name
   * @param {object} args
   * @param {{actor:object, traceId:string, stepId?:string, confirmed?:boolean, mfaVerified?:boolean,
   *          newDevice?:boolean, grant?:object, dailySpentCents?:number}} ctx
   */
  execute(name, args, ctx) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, code: 'UNKNOWN_TOOL', message: `工具 ${name} 不存在` };
    }

    const args2 = tool.validate ? tool.validate(args ?? {}) : (args ?? {});
    // 鉴权用原始参数与校验后参数的并集：防止 validate 丢掉 userId 等越权字段
    const authArgs = { ...(args ?? {}), ...args2 };
    const decision = authorize({
      actor: ctx.actor,
      tool: name,
      args: authArgs,
      ctx: {
        newDevice: ctx.newDevice,
        grant: ctx.grant,
        dailySpentCents: ctx.dailySpentCents,
      },
    });

    if (!decision.allowed) {
      this.audit.append({
        traceId: ctx.traceId,
        actor: ctx.actor?.id ?? 'anonymous',
        event: 'tool.denied',
        level: decision.level,
        detail: { tool: name, args: digestArgs(args2), denyCode: decision.denyCode, reasons: decision.reasons },
      });
      return { ok: false, code: 'DENIED', decision, message: decision.reasons[0]?.detail ?? '权限拒绝' };
    }

    if (decision.needMfa && !ctx.mfaVerified) {
      this.audit.append({
        traceId: ctx.traceId,
        actor: ctx.actor?.id ?? 'anonymous',
        event: 'tool.denied',
        level: decision.level,
        detail: { tool: name, reason: 'mfa_required', args: digestArgs(args2) },
      });
      return { ok: false, code: 'MFA_REQUIRED', decision, message: '该操作需多因子认证（L3）' };
    }

    if (decision.needConfirm && !ctx.confirmed) {
      this.audit.append({
        traceId: ctx.traceId,
        actor: ctx.actor?.id ?? 'anonymous',
        event: 'tool.denied',
        level: decision.level,
        detail: { tool: name, reason: 'confirmation_required', args: digestArgs(args2) },
      });
      return { ok: false, code: 'CONFIRMATION_REQUIRED', decision, message: '该操作需用户二次确认（L2 以上）' };
    }

    try {
      const data = tool.run({ ...ctx, args: args2 });
      this.audit.append({
        traceId: ctx.traceId,
        actor: ctx.actor.id,
        event: 'tool.executed',
        level: decision.level,
        detail: {
          tool: name,
          stepId: ctx.stepId ?? null,
          level: decision.level,
          paramsDigest: digestArgs(args2),
          resultStatus: 'ok',
        },
      });
      return { ok: true, data, decision };
    } catch (err) {
      this.audit.append({
        traceId: ctx.traceId,
        actor: ctx.actor?.id ?? 'anonymous',
        event: 'tool.failed',
        level: decision.level,
        detail: { tool: name, code: err.code ?? 'ERROR', message: String(err.message).slice(0, 120) },
      });
      return { ok: false, code: err.code ?? 'ERROR', message: err.message, decision };
    }
  }
}

/** 参数摘要：不落原始手机号与卡号，只留可复算摘要 */
function digestArgs(args) {
  const safe = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === 'phone' || k === 'cardNo' || k === 'idCard') {
      safe[k] = v ? `${String(v).slice(0, 3)}****${String(v).slice(-2)}` : null;
    } else if (typeof v === 'string' && v.length > 64) {
      safe[k] = `${v.slice(0, 16)}…(${v.length})`;
    } else {
      safe[k] = v;
    }
  }
  return JSON.parse(canonicalJson(safe));
}
