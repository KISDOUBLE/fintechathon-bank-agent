/**
 * 钥匙体检：只报告"有没有 / 格式对不对 / 能不能用"，绝不打印完整密钥。
 * 用法：node scripts/key-check.mjs
 */

import { loadEnvFile } from '../src/core/env.mjs';
import { llmConfig } from '../src/llm/deepseek.mjs';

loadEnvFile();
const cfg = llmConfig();

function mask(k) {
  if (!k) return '(空)';
  if (k.length <= 8) return `${k.slice(0, 2)}***`;
  return `${k.slice(0, 3)}…${k.slice(-2)}（共 ${k.length} 位）`;
}

console.log('钥匙体检');
console.log(`  模型地址：${cfg.baseUrl}`);
console.log(`  模型名称：${cfg.model}`);

if (!cfg.apiKey) {
  console.log('  密钥：❌ 没有找到');
  console.log('\n处理：在项目根目录的 .env 里写一行 DEEPSEEK_API_KEY=sk-...，保存后重跑本命令。');
  process.exit(1);
}

console.log(`  密钥：${mask(cfg.apiKey)}`);

if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(cfg.apiKey)) {
  console.log('  格式：⚠️ 不像标准的 sk- 开头密钥，请检查是不是多复制了空格或引号');
}

try {
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) {
    console.log('  连通：❌ 密钥被拒绝（401）。可能复制不完整，或这把 key 已被删除');
    process.exit(1);
  }
  if (!res.ok) {
    console.log(`  连通：⚠️ HTTP ${res.status}`);
    process.exit(1);
  }
  const json = await res.json();
  const ids = (json.data ?? []).map((m) => m.id);
  console.log('  连通：✅ 密钥有效');
  console.log(`  可用模型：${ids.join('、') || '(接口未返回列表)'}`);
  if (ids.length && !ids.includes(cfg.model)) {
    console.log(`  提示：当前配置的模型名 ${cfg.model} 不在列表里，可能需要改成上面某一个`);
  }
  console.log('\n下一步：node scripts/llm-test.mjs');
} catch (err) {
  console.log(`  连通：❌ 请求失败 — ${err.message}`);
  process.exit(1);
}
