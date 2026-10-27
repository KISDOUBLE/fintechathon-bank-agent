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
  const login = (userId, pin) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, pin }),
    });
  const chat = (token, body) =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  try {
    return await fn({ app, base, login, chat });
  } finally {
    await new Promise((r) => server.close(r));
    app.db.close();
  }
}

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
