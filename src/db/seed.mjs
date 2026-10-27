/**
 * 种子数据：确定性（不使用随机、不使用当前时间做业务数据骨干），保证评测可复现。
 * 金额一律整数分。
 */

import { EQUITY_ACCOUNT, SUSPENSE_ACCOUNT } from './schema.mjs';

const iso = (d) => d.toISOString();
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
};

export function seed(db) {
  db.ensureSystemAccounts();

  const now = iso(new Date());
  const users = [
    ['u_1001', '张伟', '13800000001', 2],
    ['u_1002', '李娜', '13800000002', 2],
    ['u_1003', '王小明', '13800000003', 1],
  ];
  const insUser = db.db.prepare(
    'INSERT OR IGNORE INTO users (id, name, phone, kyc_level, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [id, name, phone, kyc] of users) insUser.run(id, name, phone, kyc, now);

  // 演示用登录 PIN（真实系统应为 OTP / 生物识别）
  const DEMO_PIN = '123456';
  for (const [id] of users) {
    const row = db.db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(id);
    if (!row?.pin_hash) db.setUserPin(id, DEMO_PIN);
  }

  const insAcct = db.db.prepare(
    'INSERT OR IGNORE INTO accounts (id, user_id, kind, balance_cents) VALUES (?, ?, ?, ?)',
  );
  insAcct.run('acc_1001', 'u_1001', 'checking', 5_230_000); // ¥52,300.00
  insAcct.run('acc_1002', 'u_1002', 'checking', 1_880_000);
  insAcct.run('acc_1003', 'u_1003', 'checking', 640_000);

  // 开户资金：对权益账户记一笔，保持全账本平衡
  const insEntry = db.db.prepare('INSERT INTO entries (txn_id, account_id, delta_cents, created_at) VALUES (?, ?, ?, ?)');
  const opening = [
    ['acc_1001', 5_230_000],
    ['acc_1002', 1_880_000],
    ['acc_1003', 640_000],
    ['SYS_YIELD', 10_000_000],
  ];
  const openingTotal = opening.reduce((s, [, v]) => s + v, 0);
  const hasOpening = db.db.prepare("SELECT COUNT(*) n FROM transactions WHERE id = 'txn_opening'").get().n;
  if (!hasOpening) {
    db.tx(() => {
      db.db
        .prepare(
          `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, memo, category, created_at)
           VALUES ('txn_opening','seed','topup','committed',?,?,?,?,'开户',?)`,
        )
        .run(openingTotal, EQUITY_ACCOUNT, 'acc_1001', '种子开户资金', now);
      for (const [acct, amt] of opening) {
        insEntry.run('txn_opening', acct, amt, now);
        insEntry.run('txn_opening', EQUITY_ACCOUNT, -amt, now);
      }
      db.assertBalanced('txn_opening');
    });
  }

  const insContact = db.db.prepare(
    'INSERT OR IGNORE INTO contacts (id, user_id, name, alias, phone, tag, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insContact.run('c_1001_1', 'u_1001', '王小明', '小王', '13800000003', '同事', 'acc_1003');
  insContact.run('c_1001_2', 'u_1001', '李娜', '娜娜', '13800000002', '家人', 'acc_1002');
  insContact.run('c_1001_3', 'u_1001', '房东李叔', '李叔', '13900000009', '房东', null);
  insContact.run('c_1001_4', 'u_1001', '妈妈', '妈', '13900000008', '家人', null);

  // 历史消费：近 90 天，固定清单
  const payments = [
    ['美团外卖', '餐饮', 3_800, 1],
    ['瑞幸咖啡', '餐饮', 1_900, 2],
    ['地铁通勤', '交通', 600, 2],
    ['滴滴出行', '交通', 3_200, 4],
    ['京东商城', '购物', 25_900, 5],
    ['盒马鲜生', '生活', 8_750, 6],
    ['美团外卖', '餐饮', 4_200, 7],
    ['电影院', '娱乐', 6_000, 9],
    ['中国移动', '生活缴费', 10_000, 10],
    ['淘宝', '购物', 15_800, 12],
    ['瑞幸咖啡', '餐饮', 2_100, 13],
    ['滴滴出行', '交通', 2_800, 15],
    ['健身房年卡', '娱乐', 199_000, 18],
    ['盒马鲜生', '生活', 9_600, 20],
    ['美团外卖', '餐饮', 3_500, 22],
    ['星巴克', '餐饮', 4_500, 25],
    ['京东商城', '购物', 89_000, 28],
    ['地铁通勤', '交通', 600, 30],
    ['水电燃气', '生活缴费', 23_000, 33],
    ['海底捞', '餐饮', 32_000, 36],
    ['淘宝', '购物', 6_700, 40],
    ['滴滴出行', '交通', 4_100, 44],
    ['美团外卖', '餐饮', 5_600, 48],
    ['爱奇艺年费', '娱乐', 24_800, 52],
    ['盒马鲜生', '生活', 7_300, 56],
    ['京东商城', '购物', 12_400, 60],
    ['中国移动', '生活缴费', 10_000, 65],
    ['美团外卖', '餐饮', 2_900, 70],
    ['淘宝', '购物', 3_300, 78],
    ['滴滴出行', '交通', 1_900, 85],
  ];

  const hasPayments = db.db.prepare("SELECT COUNT(*) n FROM transactions WHERE trace_id = 'seed' AND type = 'payment'").get().n;
  if (!hasPayments) {
    db.tx(() => {
      payments.forEach(([merchant, category, amount, d], i) => {
        const id = `txn_seed_${String(i).padStart(3, '0')}`;
        const at = daysAgo(d);
        db.db
          .prepare(
            `INSERT INTO transactions (id, trace_id, type, status, amount_cents, from_account, to_account, merchant, category, memo, created_at)
             VALUES (?, 'seed', 'payment', 'committed', ?, ?, ?, ?, ?, '', ?)`,
          )
          .run(id, amount, 'acc_1001', SUSPENSE_ACCOUNT, merchant, category, at);
        insEntry.run(id, 'acc_1001', -amount, at);
        insEntry.run(id, SUSPENSE_ACCOUNT, amount, at);
        db.assertBalanced(id);
      });
    });
  }

  const insSub = db.db.prepare(
    `INSERT OR IGNORE INTO subscriptions (id, user_id, merchant, amount_cents, cycle, next_charge_at, status, last_charged_at)
     VALUES (?, ?, ?, ?, 'monthly', ?, 'active', ?)`,
  );
  insSub.run('sub_1', 'u_1001', '某某视频会员', 2_500, daysAgo(-3), daysAgo(27));
  insSub.run('sub_2', 'u_1001', '云音乐黑胶', 1_500, daysAgo(-9), daysAgo(21));
  insSub.run('sub_3', 'u_1001', '云盘 2TB', 900, daysAgo(-15), daysAgo(15));

  // 理财产品
  const insProd = db.db.prepare(
    'INSERT OR IGNORE INTO products (id, name, risk_level, annual_rate_bp, min_amount_cents, term_days) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insProd.run('p1', '稳健货币A', 1, 180, 10_000, 0);
  insProd.run('p2', '稳健债券180天', 2, 260, 100_000, 180);
  insProd.run('p3', '平衡混合一年', 3, 340, 500_000, 365);
  insProd.run('p4', '指数增强一年', 4, 450, 1_000_000, 365);

  // 银行卡
  const insCard = db.db.prepare(
    'INSERT OR IGNORE INTO cards (id, user_id, brand, last4, credit_limit_cents, daily_limit_cents, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insCard.run('card_1001', 'u_1001', '储蓄卡', '8899', 5_000_000, 2_000_000, 'active');

  return { users: users.length, payments: payments.length, subscriptions: 3, products: 4, cards: 1 };
}
