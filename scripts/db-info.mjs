/**
 * 数据自查：账本存在哪、有哪些表、敏感字段怎么存的。
 * 用法：node scripts/db-info.mjs
 */

import { statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const path = process.env.DB_PATH || 'data/bank.db';
if (!existsSync(path)) {
  console.error(`账本不存在：${path}（先跑 node scripts/reset.mjs）`);
  process.exit(1);
}

const size = statSync(path).size;
const db = new DatabaseSync(path, { readOnly: true });

console.log(`账本文件：${path}`);
console.log(`体积：${(size / 1024).toFixed(1)} KB\n`);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
console.log('表与行数：');
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).get().c;
  console.log(`  ${t.name.padEnd(16)}${n}`);
}

console.log('\nusers 表字段：');
console.log('  ' + db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).join(', '));

const u = db.prepare('SELECT id, name, phone, pin_salt, pin_hash FROM users WHERE id = ?').get('u_1001');
if (u) {
  console.log('\n一条用户记录（脱敏显示）：');
  console.log(`  id       ${u.id}`);
  console.log(`  name     ${u.name}`);
  console.log(`  phone    ${u.phone.slice(0, 3)}****${u.phone.slice(-2)}`);
  console.log(`  pin_salt ${u.pin_salt ? u.pin_salt.slice(0, 8) + '…（' + u.pin_salt.length + ' 位）' : '无'}`);
  console.log(`  pin_hash ${u.pin_hash ? u.pin_hash.slice(0, 12) + '…（' + u.pin_hash.length + ' 位）' : '无'}`);
  console.log(`  明文 PIN 是否入库：${u.pin_hash === '123456' ? '是（异常）' : '否'}`);
}

const acct = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
const txns = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
console.log(`\n账户 ${acct} 个，交易 ${txns} 笔，全局借贷合计 ${db.prepare('SELECT COALESCE(SUM(delta_cents),0) AS s FROM entries').get().s}`);
db.close();
