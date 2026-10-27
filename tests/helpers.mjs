import { bootstrap } from '../src/bootstrap.mjs';

/** 每个用例一套独立内存库，互不污染 */
export function makeApp() {
  return bootstrap({ dbPath: ':memory:', withSeed: true, enableLLM: false });
}

/** 走完确认流程的小工具 */
export async function chat(app, text, opts = {}) {
  return app.agent.handle({ userId: opts.userId ?? 'u_1001', text, newDevice: Boolean(opts.newDevice) });
}

export async function confirm(app, token, mfaCode = null, userId = 'u_1001') {
  return app.agent.confirm({ userId, token, mfaCode });
}
