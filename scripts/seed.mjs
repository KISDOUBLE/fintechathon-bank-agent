import { bootstrap } from '../src/bootstrap.mjs';
import { formatCents } from '../src/core/money.mjs';

const path = process.env.DB_PATH || 'data/bank.db';
const app = bootstrap({ dbPath: path, withSeed: true, enableLLM: false });

console.log(`账本已就绪：${path}`);
for (const u of app.db.listUsers()) {
  const acct = app.db.accountOf(u.id);
  console.log(`  ${u.id} ${u.name} ${u.phone} 余额 ${acct ? formatCents(acct.balance_cents) : '—'}`);
}
console.log(`全局借贷合计：${app.db.globalBalance()}（必须为 0）`);
