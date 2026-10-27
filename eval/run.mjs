/**
 * 端到端评测器：每条用例起一个独立内存账本 + 真实 HTTP 服务，走渠道层。
 * 判定三步全对：状态/颜色/规则 对、参数对、终态数据对。
 *
 * 用法：
 *   node eval/run.mjs            # 离线（纯规则）
 *   node eval/run.mjs --llm      # 接入真实模型
 *   node eval/run.mjs --suite redteam
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { bootstrap } from '../src/bootstrap.mjs';
import { createServer } from '../src/server.mjs';
import { cases, llmCases } from './cases.mjs';

const useLLM = process.argv.includes('--llm');
const suiteArg = process.argv.includes('--suite') ? process.argv[process.argv.indexOf('--suite') + 1] : null;

const picked = [...cases, ...(useLLM ? llmCases : [])].filter((c) => !suiteArg || c.suite === suiteArg);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function withServer(fn) {
  const app = bootstrap({ dbPath: ':memory:', withSeed: true, enableLLM: useLLM });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    return await fn({ app, post, base });
  } finally {
    await new Promise((r) => server.close(r));
    app.db.close();
  }
}

function checkExpect(expect, out, app, phase = 'chat') {
  if (!expect || expect.status === 'any') {
    if (expect?.check) expect.check(app, out);
    return;
  }
  if (expect.status) assert(out.status === expect.status, `${phase} 状态 ${out.status} ≠ ${expect.status}`);
  if (expect.statusIn) assert(expect.statusIn.includes(out.status), `${phase} 状态 ${out.status} 不在 ${expect.statusIn.join('/')}`);
  if (expect.level) assert(out.level === expect.level, `${phase} 颜色 ${out.level} ≠ ${expect.level}`);
  if (expect.rules) {
    const got = (out.rules ?? []).map((r) => r.rule);
    for (const r of expect.rules) assert(got.includes(r), `${phase} 缺规则 ${r}，实际 ${got.join(',') || '无'}`);
  }
  if (expect.reply) {
    for (const re of expect.reply) assert(re.test(out.reply ?? ''), `${phase} 回复不匹配 ${re}：${(out.reply ?? '').slice(0, 60)}`);
  }
  if (expect.confirm) {
    const c = out.confirm;
    assert(c, `${phase} 缺少确认卡`);
    if (expect.confirm.mfa !== undefined) assert(c.mfaRequired === expect.confirm.mfa, `${phase} MFA 期望 ${expect.confirm.mfa} 实际 ${c.mfaRequired}`);
    if (expect.confirm.level) assert(c.level === expect.confirm.level, `${phase} 确认级别 ${c.level} ≠ ${expect.confirm.level}`);
    if (expect.confirm.items !== undefined) assert((c.items?.length ?? 0) === expect.confirm.items, `${phase} 条目 ${c.items?.length} ≠ ${expect.confirm.items}`);
    if (expect.confirm.summary) assert(expect.confirm.summary.test(c.summary ?? ''), `${phase} 摘要不匹配：${c.summary}`);
  }
  if (expect.check) expect.check(app, out);
}

const results = [];
for (const c of picked) {
  const t0 = Date.now();
  try {
    await withServer(async ({ app, post }) => {
      let out = null;
      // 以 [ 开头的用例是“直调工具层”，不走对话
      if (!c.text.startsWith('[')) {
        const first = await post('/api/chat', { userId: c.userId ?? 'u_1001', text: c.text, newDevice: Boolean(c.newDevice) });
        assert(first.status === 200, `HTTP ${first.status}`);
        out = first.json;
        checkExpect(c.expect ?? {}, out, app);

        if (c.expect?.confirm) {
          const code = c.mfa === 'wrong' ? '000000' : out.confirm?.demoMfaCode ?? null;
          const second = await post('/api/confirm', { userId: c.userId ?? 'u_1001', token: out.confirm.token, mfaCode: code });
          assert(second.status === 200, `confirm HTTP ${second.status}`);
          checkExpect(c.expect.afterConfirm ?? {}, second.json, app, 'confirm');
        }
      }
      if (c.custom) await c.custom({ app, post, out, userId: c.userId ?? 'u_1001' });
    });
    results.push({ id: c.id, suite: c.suite, text: c.text, ok: true, ms: Date.now() - t0 });
  } catch (err) {
    results.push({ id: c.id, suite: c.suite, text: c.text, ok: false, ms: Date.now() - t0, error: err.message });
  }
}

// ---------------- 报告 ----------------
const bySuite = {};
for (const r of results) {
  bySuite[r.suite] ??= { total: 0, pass: 0 };
  bySuite[r.suite].total += 1;
  if (r.ok) bySuite[r.suite].pass += 1;
}

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

console.log(`端到端评测（${useLLM ? '规则 + 模型' : '纯规则'}）· 共 ${results.length} 条\n`);
for (const r of results) {
  console.log(`${r.ok ? '✔' : '✖'} ${pad(r.id, 6)}${pad(r.text, 26)}${r.ok ? `${r.ms}ms` : r.error}`);
}

console.log('\n分组结果：');
for (const [suite, s] of Object.entries(bySuite)) {
  console.log(`  ${pad(suite, 12)}${s.pass}/${s.total}  ${((s.pass / s.total) * 100).toFixed(1)}%`);
}

const pass = results.filter((r) => r.ok).length;
const report = {
  at: new Date().toISOString(),
  mode: useLLM ? 'rules+llm' : 'rules',
  total: results.length,
  pass,
  bySuite,
  results,
};
mkdirSync(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { recursive: true });
writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2));

console.log(`\n总计 ${pass}/${results.length}（${((pass / results.length) * 100).toFixed(1)}%），报告写入 eval/report.json`);
if (pass !== results.length) process.exitCode = 1;
