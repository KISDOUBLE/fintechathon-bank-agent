/**
 * 工具定义。每个工具只做一件事，参数校验在 validate，业务异常用 code 抛出。
 * 工具返回的 data 视为不可信数据，由调用方包裹后再交给模型。
 */

import { formatCents, assertCents } from '../core/money.mjs';
import { SUSPENSE_ACCOUNT } from '../db/schema.mjs';
import { codedError } from '../db/ledger.mjs';
import { inspectInput } from '../core/guard.mjs';

const DAY_MS = 86_400_000;

export function createTools(db) {
  return [
    {
      name: 'query_balance',
      description: '查询本人活期账户余额',
      reversible: true,
      validate: () => ({}),
      run: ({ actor }) => {
        const acct = db.accountOf(actor.id);
        if (!acct) throw codedError('NO_ACCOUNT', '账户不存在');
        return { accountId: acct.id, balanceCents: acct.balance_cents, balanceText: formatCents(acct.balance_cents) };
      },
    },

    {
      name: 'list_transactions',
      description: '查询本人最近交易流水',
      reversible: true,
      validate: (a) => {
        const limit = Number.isInteger(a.limit) ? Math.min(Math.max(a.limit, 1), 50) : 10;
        return { limit };
      },
      run: ({ actor, args }) => {
        const rows = db.listTransactions(actor.id, args.limit);
        return {
          count: rows.length,
          items: rows.map((r) => ({
            id: r.id,
            direction: r.direction,
            amountCents: r.amount_cents,
            amountText: formatCents(r.amount_cents),
            merchant: r.merchant,
            category: r.category,
            at: r.created_at,
          })),
        };
      },
    },

    {
      name: 'list_contacts',
      description: '列出本人通讯录收款人，用于消歧',
      reversible: true,
      validate: () => ({}),
      run: ({ actor }) => {
        const rows = db.listContacts(actor.id);
        return {
          count: rows.length,
          items: rows.map((c) => ({ name: c.name, phone: maskPhone(c.phone), tag: c.tag, inBank: Boolean(c.account_id) })),
        };
      },
    },

    {
      name: 'bill_analyze',
      description: '分析本人近 N 天消费：分类汇总、Top 商户、异常交易',
      reversible: true,
      validate: (a) => {
        const days = Number.isInteger(a.days) ? Math.min(Math.max(a.days, 1), 365) : 30;
        return { days };
      },
      run: ({ actor, args }) => {
        const since = new Date(Date.now() - args.days * DAY_MS).toISOString();
        const rows = db.expenses(actor.id, since);
        if (rows.length === 0) {
          return { days: args.days, count: 0, totalCents: 0, totalText: '¥0.00', categories: [], topMerchants: [], anomalies: [] };
        }
        const total = rows.reduce((s, r) => s + r.amount_cents, 0);
        const byCat = new Map();
        const byMerchant = new Map();
        for (const r of rows) {
          const c = byCat.get(r.category) ?? { category: r.category, totalCents: 0, count: 0 };
          c.totalCents += r.amount_cents;
          c.count += 1;
          byCat.set(r.category, c);
          const m = byMerchant.get(r.merchant) ?? { merchant: r.merchant, totalCents: 0, count: 0 };
          m.totalCents += r.amount_cents;
          m.count += 1;
          byMerchant.set(r.merchant, m);
        }
        const categories = [...byCat.values()]
          .sort((a, b) => b.totalCents - a.totalCents)
          .map((c) => ({
            ...c,
            totalText: formatCents(c.totalCents),
            // 占比用万分比整数表示，避免浮点
            shareBp: Math.round((c.totalCents * 10000) / total),
          }));
        const topMerchants = [...byMerchant.values()]
          .sort((a, b) => b.totalCents - a.totalCents)
          .slice(0, 5)
          .map((m) => ({ ...m, totalText: formatCents(m.totalCents) }));

        // 异常：单笔 ≥ ¥500 且 ≥ 该分类均值的 3 倍
        const catAvg = new Map(categories.map((c) => [c.category, Math.round(c.totalCents / c.count)]));
        const anomalies = rows
          .filter((r) => r.amount_cents >= 50_000 && r.amount_cents >= 3 * (catAvg.get(r.category) ?? 0))
          .map((r) => ({
            id: r.id,
            merchant: r.merchant,
            category: r.category,
            amountCents: r.amount_cents,
            amountText: formatCents(r.amount_cents),
            at: r.created_at,
          }));

        return {
          days: args.days,
          count: rows.length,
          totalCents: total,
          totalText: formatCents(total),
          avgCents: Math.round(total / rows.length),
          categories,
          topMerchants,
          anomalies,
        };
      },
    },

    {
      name: 'subscription_list',
      description: '列出本人订阅代扣，并给出 30 天内到期提醒',
      reversible: true,
      validate: () => ({}),
      run: ({ actor }) => {
        const rows = db.subscriptions(actor.id);
        const soon = Date.now() + 30 * DAY_MS;
        return {
          count: rows.length,
          activeCount: rows.filter((r) => r.status === 'active').length,
          items: rows.map((r) => ({
            id: r.id,
            merchant: r.merchant,
            amountCents: r.amount_cents,
            amountText: formatCents(r.amount_cents),
            cycle: r.cycle,
            status: r.status,
            nextChargeAt: r.next_charge_at,
            dueIn30d: r.status === 'active' && new Date(r.next_charge_at).getTime() <= soon,
          })),
        };
      },
    },

    {
      name: 'subscription_cancel',
      description: '取消一笔订阅代扣',
      reversible: false,
      validate: (a) => {
        if (!a.subscriptionId || typeof a.subscriptionId !== 'string') {
          throw codedError('INVALID_ARGUMENT', '缺少 subscriptionId');
        }
        return { subscriptionId: a.subscriptionId };
      },
      run: ({ actor, args }) => {
        const sub = db.cancelSubscription(actor.id, args.subscriptionId);
        return {
          id: sub.id,
          merchant: sub.merchant,
          status: sub.status,
          alreadyCancelled: Boolean(sub.alreadyCancelled),
          amountText: formatCents(sub.amount_cents),
        };
      },
    },

    {
      name: 'transfer_create',
      description: '向通讯录内收款人转账',
      reversible: false,
      validate: (a) => {
        const amountCents = assertCents(a.amountCents, '转账金额');
        const payee = String(a.payee ?? '').trim();
        if (!payee) throw codedError('INVALID_ARGUMENT', '缺少收款人');
        const memo = String(a.memo ?? '').slice(0, 80);
        // 备注来自用户，落库前做一次注入清洗（不作为指令来源）
        const memoCheck = inspectInput(memo);
        if (memoCheck.blocked) {
          throw codedError('MEMO_REJECTED', '备注包含疑似指令内容，已拒绝写入');
        }
        return { amountCents, payee, memo: memoCheck.normalized };
      },
      run: ({ actor, args, traceId, stepId }) => {
        const matches = db.findContact(actor.id, args.payee);
        if (matches.length === 0) {
          throw codedError('PAYEE_NOT_FOUND', `通讯录里没有「${args.payee}」，只能转给已存在的收款人`);
        }
        if (matches.length > 1) {
          const exact = matches.filter((m) => m.name === args.payee || m.alias === args.payee || m.phone === args.payee);
          if (exact.length !== 1) {
            throw codedError('AMBIGUOUS_PAYEE', `「${args.payee}」匹配到 ${matches.length} 个收款人，需要确认`);
          }
        }
        const contact = matches.find((m) => m.name === args.payee || m.alias === args.payee || m.phone === args.payee) ?? matches[0];
        const toAccountId = contact.account_id ?? SUSPENSE_ACCOUNT;
        const txn = db.transfer({
          traceId,
          fromUserId: actor.id,
          toAccountId,
          amountCents: args.amountCents,
          memo: args.memo,
          merchant: contact.name,
          category: '转账',
          idempotencyKey: stepId ?? 'transfer',
        });
        const acct = db.accountOf(actor.id);
        return {
          txnId: txn.id,
          amountCents: txn.amount_cents,
          amountText: formatCents(txn.amount_cents),
          payeeName: contact.name,
          payeeMasked: maskPhone(contact.phone),
          inBank: Boolean(contact.account_id),
          memo: txn.memo,
          balanceAfterCents: acct.balance_cents,
          balanceAfterText: formatCents(acct.balance_cents),
          status: txn.status,
        };
      },
    },
  ];
}

function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone);
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-2)}` : '***';
}
