/**
 * 演示重置：删掉本地账本并重新播种。
 * 用法：node scripts/reset.mjs
 */

import { existsSync, rmSync } from 'node:fs';
import { bootstrap } from '../src/bootstrap.mjs';

const path = process.env.DB_PATH || 'data/bank.db';
for (const suffix of ['', '-wal', '-shm']) {
  const f = path + suffix;
  if (!existsSync(f)) continue;
  try {
    rmSync(f, { force: true });
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY') {
      console.error(`无法删除 ${f}：文件被占用。请先停止正在运行的 server / webhook，再执行本命令。`);
      process.exit(1);
    }
    throw err;
  }
}

const app = bootstrap({ dbPath: path, withSeed: true, enableLLM: false });
console.log(`已重置：${path}`);
console.log(`用户 ${app.db.listUsers().length} 个，订阅 ${app.db.subscriptions('u_1001').length} 项，账本平衡 ${app.db.globalBalance()}`);
