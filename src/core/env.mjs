/**
 * 极简 .env 读取（零依赖）。
 * 只补缺失的变量，不覆盖已存在的环境变量；不打印、不回显任何值。
 */

import { readFileSync, existsSync } from 'node:fs';

export function loadEnvFile(path = '.env') {
  if (!existsSync(path)) return { loaded: 0 };
  let loaded = 0;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return { loaded };
}
