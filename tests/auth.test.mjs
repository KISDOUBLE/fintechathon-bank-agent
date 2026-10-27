import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../src/bootstrap.mjs';
import { createServer } from '../src/server.mjs';
import { issueToken } from '../src/auth/session.mjs';

async function withServer(fn) {
  const app = bootstrap({ dbPath: ':memory:', withSeed: true, enableLLM: false });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (account, pin) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account.startsWith('u_') ? { userId: account, pin } : { phone: account, pin }),
    });
  const register = (body) =>
    fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const chat = (token, body) =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const me = (token) => fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  const contacts = (token, body) =>
    fetch(`${base}/api/contacts`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    return await fn({ app, base, login, register, chat, me, contacts });
  } finally {
    await new Promise((r) => server.close(r));
    app.db.close();
  }
}

test('注册成功：发令牌、开户赠礼、可立即查余额', async () => {
  await withServer(async ({ register, me, chat }) => {
    const res = await register({ name: '赵六', phone: '13911112222', pin: '654321' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.token && body.user.id.startsWith('u_'));

    const profile = await me(body.token);
    assert.equal(profile.status, 200);
    const p = await profile.json();
    assert.equal(p.user.name, '赵六');
    assert.equal(p.balanceCents, 100_000); // ¥1,000 开户演示资金

    const out = await (await chat(body.token, { text: '查一下余额' })).json();
    assert.equal(out.status, 'ok');
    assert.match(out.reply, /¥1,000\.00/);
  });
});

test('注册校验：手机号重复、格式错、PIN 非 6 位', async () => {
  await withServer(async ({ register }) => {
    const dup = await register({ name: '张伟', phone: '13800000001', pin: '123456' });
    assert.equal(dup.status, 409);

    const badPhone = await register({ name: '测试', phone: '123', pin: '123456' });
    assert.equal(badPhone.status, 400);

    const badPin = await register({ name: '测试', phone: '13911113333', pin: '12345' });
    assert.equal(badPin.status, 400);

    const badName = await register({ name: 'x', phone: '13911113333', pin: '123456' });
    assert.equal(badName.status, 400);
  });
});

test('手机号登录可用（与内部 ID 登录等价）', async () => {
  await withServer(async ({ login }) => {
    const byPhone = await login('13800000001', '123456');
    assert.equal(byPhone.status, 200);
    const byId = await login('u_1001', '123456');
    assert.equal(byId.status, 200);
  });
});

test('收款人：新增、列表、去重；行内手机号自动关联账户', async () => {
  await withServer(async ({ login, contacts }) => {
    const { token } = await (await login('u_1001', '123456')).json();

    const add = await contacts(token, { name: '赵六', phone: '13800000002' });
    assert.equal(add.status, 201);
    const added = await add.json();
    assert.equal(added.contact.inBank, true);

    const list = await (await contacts(token)).json();
    assert.ok(list.contacts.some((c) => c.name === '赵六'));

    const dup = await contacts(token, { name: '赵六', phone: '13800000002' });
    assert.equal(dup.status, 409);
  });
});

test('新用户没有收款人时转账会被追问', async () => {
  await withServer(async ({ register, chat }) => {
    const { token } = await (await register({ name: '新人', phone: '13911114444', pin: '123456' })).json();
    const out = await (await chat(token, { text: '转给王小明 100 元' })).json();
    assert.equal(out.status, 'clarify');
  });
});

test('未携带令牌访问业务接口返回 401', async () => {
  await withServer(async ({ chat }) => {
    const res = await chat(null, { text: '查一下余额' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('PIN 错误返回 401，正确返回令牌', async () => {
  await withServer(async ({ login, chat, base }) => {
    const bad = await login('u_1001', '000000');
    assert.equal(bad.status, 401);

    const ok = await login('u_1001', '123456');
    assert.equal(ok.status, 200);
    const { token, expiresIn, user } = await ok.json();
    assert.ok(token.includes('.'));
    assert.equal(expiresIn, 1800);
    assert.equal(user.name, '张伟');

    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: '查一下余额' }),
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.status, 'ok');
  });
});

test('令牌被篡改返回 401', async () => {
  await withServer(async ({ login, chat }) => {
    const { token } = await (await login('u_1001', '123456')).json();
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const res = await chat(tampered, { text: '查一下余额' });
    assert.equal(res.status, 401);
  });
});

test('过期令牌返回 401', async () => {
  await withServer(async ({ chat }) => {
    const { token } = issueToken('u_1001', -1000);
    const res = await chat(token, { text: '查一下余额' });
    assert.equal(res.status, 401);
  });
});

test('令牌身份与请求体 userId 不一致返回 403', async () => {
  await withServer(async ({ login, chat }) => {
    const { token } = await (await login('u_1001', '123456')).json();
    const res = await chat(token, { userId: 'u_1002', text: '查一下余额' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'user_mismatch');
  });
});

test('连续失败 5 次后锁定登录', async () => {
  await withServer(async ({ login }) => {
    for (let i = 0; i < 5; i += 1) {
      const r = await login('u_1003', 'wrong');
      assert.equal(r.status, 401);
    }
    const locked = await login('u_1003', '123456');
    assert.equal(locked.status, 429);
  });
});

test('PIN 不以明文存储', async () => {
  await withServer(async ({ app }) => {
    const row = app.db.db.prepare('SELECT pin_salt, pin_hash FROM users WHERE id = ?').get('u_1001');
    assert.ok(row.pin_salt && row.pin_salt.length >= 16);
    assert.ok(row.pin_hash && row.pin_hash.length === 64);
    assert.notEqual(row.pin_hash, '123456');
  });
});
