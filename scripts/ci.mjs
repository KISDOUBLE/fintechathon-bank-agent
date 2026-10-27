/**
 * 本地 CI：静态安全扫描 + 单测 + 冒烟。
 * 不联网；任何一步失败即非 0 退出。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const NODE = process.execPath;
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'submission', 'eval', '.venv', '__pycache__']);
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.html', '.yml', '.yaml', '.txt', '.example']);

const problems = [];
const notes = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function step(title, fn) {
  process.stdout.write(`\n[CI] ${title}\n`);
  try {
    fn();
  } catch (err) {
    problems.push(`${title}: ${err.message}`);
    console.log(`  ✖ ${err.message}`);
  }
}

const files = walk(root).filter((f) => TEXT_EXT.has(extname(f)));

step('密钥与敏感信息扫描', () => {
  const patterns = [
    [/sk-[A-Za-z0-9]{20,}/, '疑似 API Key（sk- 前缀）'],
    [/Bearer\s+[A-Za-z0-9._-]{24,}/, '疑似 Bearer Token'],
    [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, '私钥'],
    [/\b\d{17}[\dXx]\b/, '疑似身份证号'],
    [/\b(?:4\d{15}|5[1-5]\d{14}|62\d{14,17})\b/, '疑似银行卡号'],
  ];
  let hits = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const [re, label] of patterns) {
      const m = text.match(re);
      if (m) {
        // .env.example 里的空占位不算
        if (f.endsWith('.env.example') && /=\s*$/.test(m[0])) continue;
        hits += 1;
        problems.push(`${label} @ ${f.replace(root, '')}`);
      }
    }
  }
  console.log(hits === 0 ? `  ✔ 扫描 ${files.length} 个文本文件，未发现密钥/明文卡号` : `  ✖ 发现 ${hits} 处`);
});

step('占位实现扫描', () => {
  const bad = /(\bTODO\b|\bFIXME\b|待实现|尚未实现|placeholder)/;
  const self = join(root, 'scripts', 'ci.mjs');
  let hits = 0;
  for (const f of files.filter((x) => x.endsWith('.mjs') && x !== self)) {
    const text = readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (bad.test(line)) {
        hits += 1;
        problems.push(`占位标记 ${f.replace(root, '')}:${i + 1} — ${line.trim().slice(0, 60)}`);
      }
    });
  }
  console.log(hits === 0 ? '  ✔ 无占位标记' : `  ✖ ${hits} 处`);
});

step('金额精度扫描：禁止浮点金额运算', () => {
  const src = files.filter((f) => f.includes(`${join(root, 'src')}`));
  let hits = 0;
  for (const f of src) {
    const text = readFileSync(f, 'utf8');
    if (/\bparseFloat\s*\(/.test(text)) {
      hits += 1;
      problems.push(`parseFloat @ ${f.replace(root, '')}`);
    }
  }
  console.log(hits === 0 ? '  ✔ 未使用 parseFloat' : `  ✖ ${hits} 处`);
});

step('单元测试', () => {
  const r = spawnSync(NODE, ['--test', '--test-isolation=none', 'tests/*.test.mjs'], {
    cwd: root.replace(/^\/([A-Za-z]:)/, '$1'),
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`node --test 退出码 ${r.status}`);
});

step('离线冒烟', () => {
  const r = spawnSync(NODE, ['scripts/smoke.mjs'], {
    cwd: root.replace(/^\/([A-Za-z]:)/, '$1'),
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`smoke 退出码 ${r.status}`);
});

step('端到端评测（50 条，离线）', () => {
  const r = spawnSync(NODE, ['eval/run.mjs'], {
    cwd: root.replace(/^\/([A-Za-z]:)/, '$1'),
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`eval 退出码 ${r.status}`);
});

console.log('\n================ CI 汇总 ================');
if (problems.length === 0) {
  console.log('结果：全部通过。可提交。');
} else {
  console.log(`结果：${problems.length} 个问题`);
  for (const p of problems) console.log(` - ${p}`);
  process.exitCode = 1;
}
