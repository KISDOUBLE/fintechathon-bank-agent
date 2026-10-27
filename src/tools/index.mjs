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

    // ---------------- 理财 ----------------
    {
      name: 'wealth_list',
      description: '列出理财产品与当前持仓',
      reversible: true,
      validate: (a) => ({ riskMax: Number.isInteger(a.riskMax) ? a.riskMax : 5 }),
      run: ({ actor, args }) => {
        const products = db.listProducts()
          .filter((p) => p.risk_level <= args.riskMax)
          .map((p) => ({
            id: p.id,
            name: p.name,
            riskLevel: p.risk_level,
            rateText: `${(p.annual_rate_bp / 100).toFixed(2)}%`,
            minAmountText: formatCents(p.min_amount_cents),
            termDays: p.term_days,
          }));
        const holdings = db.holdings(actor.id).map((h) => ({
          holdingId: h.id,
          productName: h.product_name,
          amountCents: h.amount_cents,
          amountText: formatCents(h.amount_cents),
          status: h.status,
          since: h.created_at,
        }));
        return { products, holdings, activeCount: holdings.filter((h) => h.status === 'active').length };
      },
    },
    {
      name: 'wealth_recommend',
      description: '按风险承受能力推荐产品',
      reversible: true,
      validate: (a) => ({ riskMax: Number.isInteger(a.riskMax) ? a.riskMax : 2 }),
      run: ({ args }) => {
        const list = db.listProducts().filter((p) => p.risk_level <= args.riskMax);
        if (!list.length) throw codedError('NO_PRODUCT', '没有符合风险等级的产品');
        return {
          riskMax: args.riskMax,
          picks: list.map((p) => ({
            id: p.id,
            name: p.name,
            riskLevel: p.risk_level,
            rateBp: p.annual_rate_bp,
            rateText: `${(p.annual_rate_bp / 100).toFixed(2)}%`,
            minAmountCents: p.min_amount_cents,
            minAmountText: formatCents(p.min_amount_cents),
          })),
        };
      },
    },
    {
      name: 'wealth_subscribe',
      description: '申购理财产品',
      reversible: false,
      validate: (a) => {
        const amountCents = assertCents(a.amountCents, '申购金额');
        const product = String(a.product ?? '').trim();
        if (!product) throw codedError('INVALID_ARGUMENT', '缺少产品名称');
        return { amountCents, product };
      },
      run: ({ actor, args, traceId }) => {
        const found = db.findProduct(args.product);
        if (!found.length) throw codedError('PRODUCT_NOT_FOUND', `没有找到产品「${args.product}」`);
        const p = found[0];
        const r = db.subscribeWealth({ userId: actor.id, productId: p.id, amountCents: args.amountCents, traceId });
        return {
          holdingId: r.holdingId,
          productName: p.name,
          amountText: formatCents(args.amountCents),
          balanceAfterText: formatCents(r.balanceAfterCents),
          riskLevel: p.risk_level,
          rateText: `${(p.annual_rate_bp / 100).toFixed(2)}%`,
        };
      },
    },
    {
      name: 'wealth_redeem',
      description: '赎回理财产品',
      reversible: false,
      validate: (a) => ({ holdingId: a.holdingId ? String(a.holdingId) : null, product: a.product ? String(a.product) : null }),
      run: ({ actor, args, traceId }) => {
        const active = db.holdings(actor.id).filter((h) => h.status === 'active');
        if (!active.length) throw codedError('NO_HOLDING', '当前没有可赎回的持仓');
        const target = args.holdingId
          ? active.find((h) => h.id === args.holdingId)
          : active.find((h) => h.product_name.includes(args.product ?? '')) ?? active[0];
        if (!target) throw codedError('HOLDING_NOT_FOUND', '没有匹配的持仓');
        const r = db.redeemWealth({ userId: actor.id, holdingId: target.id, traceId });
        return {
          productName: r.productName,
          principalText: formatCents(r.principalCents),
          interestText: formatCents(r.interestCents),
          totalText: formatCents(r.totalCents),
          days: r.days,
          balanceAfterText: formatCents(r.balanceAfterCents),
        };
      },
    },

    // ---------------- 卡片 ----------------
    {
      name: 'card_list',
      description: '列出本人银行卡状态与额度',
      reversible: true,
      validate: () => ({}),
      run: ({ actor }) => ({
        count: db.listCards(actor.id).length,
        cards: db.listCards(actor.id).map((c) => ({
          id: c.id,
          brand: c.brand,
          last4: c.last4,
          status: c.status,
          statusText: c.status === 'active' ? '正常' : '已冻结',
          dailyLimitText: formatCents(c.daily_limit_cents),
        })),
      }),
    },
    {
      name: 'card_apply',
      description: '申请虚拟卡',
      reversible: false,
      validate: (a) => ({ brand: String(a.brand ?? '虚拟卡').slice(0, 20) }),
      run: ({ actor, args }) => {
        const c = db.applyCard({ userId: actor.id, brand: args.brand });
        return { cardId: c.id, brand: c.brand, last4: c.last4, dailyLimitText: formatCents(c.daily_limit_cents) };
      },
    },
    {
      name: 'card_set_limit',
      description: '调整卡片单日交易限额',
      reversible: false,
      validate: (a) => {
        const limitCents = assertCents(a.limitCents, '限额');
        return { last4: String(a.last4 ?? ''), limitCents };
      },
      run: ({ actor, args }) => {
        const card = args.last4 ? db.findCard(actor.id, args.last4) : db.listCards(actor.id)[0];
        if (!card) throw codedError('CARD_NOT_FOUND', `没有尾号 ${args.last4} 的卡`);
        const r = db.setCardLimit(actor.id, card.id, args.limitCents);
        return {
          last4: r.last4,
          beforeText: formatCents(r.before),
          afterText: formatCents(r.daily_limit_cents),
        };
      },
    },
    {
      name: 'card_freeze',
      description: '挂失或限制卡片交易',
      reversible: false,
      validate: (a) => ({ last4: String(a.last4 ?? ''), mode: a.mode === 'lock' ? 'lock' : 'loss' }),
      run: ({ actor, args }) => {
        const card = args.last4 ? db.findCard(actor.id, args.last4) : db.listCards(actor.id)[0];
        if (!card) throw codedError('CARD_NOT_FOUND', `没有尾号 ${args.last4} 的卡`);
        const r = db.setCardStatus(actor.id, card.id, 'frozen');
        return { last4: r.last4, mode: args.mode, modeText: args.mode === 'loss' ? '挂失' : '交易限制', statusText: '已冻结' };
      },
    },
    {
      name: 'card_unfreeze',
      description: '解挂或解除交易限制',
      reversible: false,
      validate: (a) => ({ last4: String(a.last4 ?? '') }),
      run: ({ actor, args }) => {
        const card = args.last4 ? db.findCard(actor.id, args.last4) : db.listCards(actor.id)[0];
        if (!card) throw codedError('CARD_NOT_FOUND', `没有尾号 ${args.last4} 的卡`);
        const r = db.setCardStatus(actor.id, card.id, 'active');
        return { last4: r.last4, statusText: '已恢复正常' };
      },
    },

    // ---------------- 定时转账 / 平摊 ----------------
    {
      name: 'transfer_schedule_create',
      description: '创建定时转账',
      reversible: false,
      validate: (a) => ({
        payee: String(a.payee ?? '').trim(),
        amountCents: assertCents(a.amountCents, '定时转账金额'),
        runAt: String(a.runAt ?? ''),
      }),
      run: ({ actor, args }) => {
        if (!args.runAt) throw codedError('INVALID_ARGUMENT', '缺少执行时间');
        const contact = db.findContact(actor.id, args.payee)[0];
        if (!contact) throw codedError('PAYEE_NOT_FOUND', `通讯录里没有「${args.payee}」`);
        const row = db.scheduleTransfer({
          userId: actor.id,
          payeeName: contact.name,
          payeeAccount: contact.account_id ?? SUSPENSE_ACCOUNT,
          amountCents: args.amountCents,
          runAt: args.runAt,
        });
        return { id: row.id, payeeName: row.payee_name, amountText: formatCents(row.amount_cents), runAt: row.run_at };
      },
    },
    {
      name: 'transfer_schedule_list',
      description: '列出待执行的定时转账',
      reversible: true,
      validate: () => ({}),
      run: ({ actor }) => ({
        count: db.listScheduled(actor.id).length,
        items: db.listScheduled(actor.id).map((r) => ({
          id: r.id,
          payeeName: r.payee_name,
          amountText: formatCents(r.amount_cents),
          runAt: r.run_at,
        })),
      }),
    },
    {
      name: 'transfer_schedule_cancel',
      description: '取消定时转账',
      reversible: false,
      validate: (a) => ({ id: String(a.id ?? '') }),
      run: ({ actor, args }) => {
        const ids = db.listScheduled(actor.id).map((x) => x.id);
        const id = ids.includes(args.id) ? args.id : ids[0];
        if (!id) throw codedError('SCHEDULE_NOT_FOUND', '没有可取消的定时转账');
        const r = db.cancelScheduled(actor.id, id);
        return { id: r.id, payeeName: r.payee_name, amountText: formatCents(r.amount_cents), status: r.status };
      },
    },
    {
      name: 'transfer_split',
      description: '把总金额平摊给多个收款人（AA 分摊）',
      reversible: false,
      validate: (a) => {
        const totalCents = assertCents(a.totalCents, '分摊总额');
        const payees = (Array.isArray(a.payees) ? a.payees : []).map((s) => String(s).trim()).filter(Boolean);
        if (payees.length < 2) throw codedError('INVALID_ARGUMENT', '至少需要两个收款人');
        return { totalCents, payees, memo: String(a.memo ?? 'AA 分摊').slice(0, 40) };
      },
      run: ({ actor, args, traceId }) => {
        const per = Math.floor(args.totalCents / args.payees.length);
        const remainder = args.totalCents - per * args.payees.length;
        const done = [];
        args.payees.forEach((name, i) => {
          const amount = i === 0 ? per + remainder : per;
          const contact = db.findContact(actor.id, name)[0];
          if (!contact) throw codedError('PAYEE_NOT_FOUND', `通讯录里没有「${name}」`);
          const txn = db.transfer({
            traceId,
            fromUserId: actor.id,
            toAccountId: contact.account_id ?? SUSPENSE_ACCOUNT,
            amountCents: amount,
            memo: args.memo,
            merchant: contact.name,
            category: '转账',
            idempotencyKey: `split-${i}`,
          });
          done.push({ payeeName: contact.name, amountText: formatCents(amount), txnId: txn.id });
        });
        return {
          totalText: formatCents(args.totalCents),
          count: done.length,
          items: done,
          balanceAfterText: formatCents(db.accountOf(actor.id).balance_cents),
        };
      },
    },

    // ---------------- 订阅识别 ----------------
    {
      name: 'subscription_detect',
      description: '从历史流水识别疑似周期性扣费',
      reversible: true,
      validate: (a) => ({ days: Number.isInteger(a.days) ? a.days : 90 }),
      run: ({ actor, args }) => {
        const found = db.detectRecurring(actor.id, args.days);
        return {
          days: args.days,
          count: found.length,
          items: found.map((x) => ({
            merchant: x.merchant,
            count: x.count,
            avgText: formatCents(x.avgCents),
            lastAt: x.lastAt,
          })),
        };
      },
    },

    // ---------------- 跨场景联动 ----------------
    {
      name: 'birthday_setup',
      description: '生日联动：锁定预算并提前预订鲜花蛋糕',
      reversible: false,
      validate: (a) => ({
        person: String(a.person ?? '家人').slice(0, 20),
        date: String(a.date ?? ''),
        budgetCents: assertCents(a.budgetCents, '预算'),
      }),
      run: ({ actor, args, traceId }) => {
        if (!/^\d{4}-\d{2}-\d{2}/.test(args.date)) throw codedError('INVALID_ARGUMENT', '日期格式应为 YYYY-MM-DD');
        const r = db.createEvent({ userId: actor.id, person: args.person, eventDate: args.date, budgetCents: args.budgetCents, traceId });
        return {
          eventId: r.event.id,
          person: r.event.person,
          date: r.event.event_date,
          budgetText: formatCents(r.event.budget_cents),
          orders: r.orders.map((o) => ({ item: o.item, vendor: o.vendor, amountText: formatCents(o.amount_cents), at: o.scheduled_at })),
          balanceAfterText: formatCents(r.balanceAfterCents),
        };
      },
    },
    {
      name: 'event_list',
      description: '列出已安排的跨场景事件',
      reversible: true,
      validate: () => ({}),
      run: ({ actor }) => ({
        count: db.listEvents(actor.id).length,
        items: db.listEvents(actor.id).map((e) => ({
          id: e.id,
          person: e.person,
          date: e.event_date,
          budgetText: formatCents(e.budget_cents),
          status: e.status,
          orders: db.listOrders(e.id).map((o) => ({ item: o.item, at: o.scheduled_at, status: o.status })),
        })),
      }),
    },
  ];
}

function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone);
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-2)}` : '***';
}
