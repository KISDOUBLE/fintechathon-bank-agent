/**
 * 打提交包：源码 + 部署材料 → submission/03-源代码与部署材料.tar.gz
 *
 * 硬规则：
 *  - 绝不打包 .env / data/ / .git / node_modules（密钥与本地账本不出门）
 *  - 打包后重新列一遍内容，确认敏感文件没进去
 *  - 体积超过 300MB 直接失败（赛题上限）
 *
 * 用法：node scripts/package.mjs [--skip-ci]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const OUT_DIR = join(root, 'submission');
const OUT_NAME = '03-源代码与部署材料.tar.gz';
const OUT_PATH = join(OUT_DIR, OUT_NAME);
const MAX_BYTES = 300 * 1024 * 1024;

const EXCLUDES = [
  '.git',
  'node_modules',
  'data',
  '.env',
  'submission',
  'eval/report.json',
  '*.log',
  '.DS_Store',
];

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
}

console.log('打包提交物');

if (!process.argv.includes('--skip-ci')) {
  console.log('\n[1/4] 先跑 CI，不通过不打包');
  const ci = spawnSync(process.execPath, ['scripts/ci.mjs'], { cwd: root, stdio: 'inherit' });
  if (ci.status !== 0) {
    console.error('CI 未通过，已中止打包。');
    process.exit(1);
  }
} else {
  console.log('\n[1/4] 跳过 CI（--skip-ci）');
}

console.log('\n[2/4] 生成压缩包');
mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(OUT_PATH)) rmSync(OUT_PATH, { force: true });

const tarArgs = ['-czf', OUT_PATH];
for (const ex of EXCLUDES) tarArgs.push(`--exclude=${ex}`);
tarArgs.push('.');

const packed = sh('tar', tarArgs, { stdio: 'inherit' });
if (packed.status !== 0) {
  console.error('tar 打包失败：', packed.error?.message ?? '见上方输出');
  process.exit(1);
}

if (!existsSync(OUT_PATH)) {
  console.error('压缩包未生成');
  process.exit(1);
}

console.log('\n[3/4] 校验内容与体积');
const listed = sh('tar', ['-tzf', OUT_PATH]);
const entries = (listed.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);

if (!entries.length) {
  console.error('压缩包为空或无法读取');
  process.exit(1);
}

const forbidden = entries.filter((e) =>
  /(^|\/)\.env$/.test(e) ||
  e.startsWith('./data/') || e.startsWith('data/') ||
  e.includes('node_modules/') ||
  e.startsWith('./.git/') || e.startsWith('.git/') ||
  e.endsWith('report.json'),
);
if (forbidden.length) {
  console.error('压缩包内发现禁止文件：');
  for (const f of forbidden.slice(0, 10)) console.error('  - ' + f);
  process.exit(1);
}

const required = ['README.md', 'DEPLOY.md', 'package.json', 'src/agent/loop.mjs', 'tests/agent.test.mjs', 'eval/cases.mjs', 'docs/01-technical-doc.md', 'docs/04-security-report.md'];
const missing = required.filter((r) => !entries.some((e) => e === `./${r}` || e === r));
if (missing.length) {
  console.error('压缩包缺少必需文件：', missing.join(', '));
  process.exit(1);
}

const size = statSync(OUT_PATH).size;
if (size > MAX_BYTES) {
  console.error(`体积 ${(size / 1024 / 1024).toFixed(1)}MB 超过 300MB 上限`);
  process.exit(1);
}

const sha256 = createHash('sha256').update(readFileSync(OUT_PATH)).digest('hex');

console.log('\n[4/4] 写清单');
const manifest = {
  name: OUT_NAME,
  at: new Date().toISOString(),
  bytes: size,
  humanSize: `${(size / 1024).toFixed(1)} KB`,
  entries: entries.length,
  sha256,
  excluded: EXCLUDES,
  required: required.map((r) => ({ path: r, ok: true })),
};
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`  文件：submission/${OUT_NAME}`);
console.log(`  体积：${manifest.humanSize}（上限 300MB）`);
console.log(`  条目：${entries.length}`);
console.log(`  SHA256：${sha256.slice(0, 16)}…`);
console.log(`  明令排除：${EXCLUDES.join(', ')}`);
console.log('\n打包完成。');
