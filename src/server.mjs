/**
 * Web 渠道：静态页 + JSON API。渠道层只做转发，不做任何业务判定。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bootstrap } from './bootstrap.mjs';
import { issueToken, verifyToken, isLoginLocked, recordLoginFailure, clearLoginFailures } from './auth/session.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 64 * 1024;

export function createServer(app = bootstrap()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return sendFile(res, path.join(WEB_ROOT, 'index.html'), 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const body = await readJson(req);
        const name = String(body.name ?? '').trim();
        const phone = String(body.phone ?? '').trim();
        const pin = String(body.pin ?? '');
        if (name.length < 2 || name.length > 20) return sendJson(res, 400, { error: 'bad_name', message: '姓名需 2–20 个字符' });
        if (!/^1[3-9]\d{9}$/.test(phone)) return sendJson(res, 400, { error: 'bad_phone', message: '手机号格式不正确' });
        if (!/^\d{6}$/.test(pin)) return sendJson(res, 400, { error: 'bad_pin', message: 'PIN 需 6 位数字' });
        try {
          const user = app.db.registerUser({ name, phone, pin });
          const { token, expiresIn } = issueToken(user.id);
          app.audit.append({ traceId: `reg_${Date.now()}`, actor: user.id, event: 'auth.registered', detail: { phone } });
          return sendJson(res, 201, { token, expiresIn, user });
        } catch (err) {
          if (err.code === 'PHONE_TAKEN') return sendJson(res, 409, { error: 'phone_taken', message: '该手机号已注册' });
          return sendJson(res, 400, { error: 'register_failed', message: String(err.message).slice(0, 120) });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJson(req);
        const account = String(body.userId ?? body.phone ?? '');
        const pin = String(body.pin ?? '');
        if (isLoginLocked(account)) {
          return sendJson(res, 429, { error: 'too_many_attempts', message: '登录尝试过多，请 60 秒后再试' });
        }
        // 支持用内部 ID 或手机号登录
        const byPhone = account.startsWith('u_') ? null : app.db.getUserByPhone(account);
        const userId = account.startsWith('u_') ? account : byPhone?.id ?? '';
        const user = userId ? app.db.authenticatePin(userId, pin) : null;
        if (!user) {
          recordLoginFailure(account);
          app.audit.append({ traceId: `login_${Date.now()}`, actor: account || 'anonymous', event: 'auth.login_failed', level: 'red', detail: { account } });
          return sendJson(res, 401, { error: 'invalid_credentials' });
        }
        clearLoginFailures(account);
        const { token, expiresIn } = issueToken(user.id);
        app.audit.append({ traceId: `login_${Date.now()}`, actor: user.id, event: 'auth.login', detail: { ttlSec: expiresIn } });
        return sendJson(res, 200, { token, expiresIn, user: { id: user.id, name: user.name } });
      }

      // 除登录、注册与健康检查外，所有 API 都必须携带身份令牌
      let authUser = null;
      if (url.pathname.startsWith('/api/') && !['/api/health', '/api/login', '/api/register'].includes(url.pathname)) {
        const header = req.headers.authorization || '';
        const raw = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-session-token'];
        const v = verifyToken(raw);
        if (!v.ok) {
          return sendJson(res, 401, { error: 'unauthorized', reason: v.reason });
        }
        authUser = app.db.getUser(v.userId);
        if (!authUser) return sendJson(res, 401, { error: 'unknown_user' });
      }

      if (req.method === 'GET' && url.pathname === '/api/me') {
        const acct = app.db.accountOf(authUser.id);
        return sendJson(res, 200, {
          user: { id: authUser.id, name: authUser.name, phone: authUser.phone },
          balanceCents: acct?.balance_cents ?? 0,
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/contacts') {
        return sendJson(res, 200, {
          contacts: app.db.listContacts(authUser.id).map((c) => ({ name: c.name, alias: c.alias, phone: c.phone, inBank: Boolean(c.account_id) })),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/contacts') {
        const body = await readJson(req);
        const name = String(body.name ?? '').trim();
        const phone = body.phone ? String(body.phone).trim() : null;
        if (name.length < 1 || name.length > 20) return sendJson(res, 400, { error: 'bad_name', message: '收款人姓名需 1–20 个字符' });
        if (phone && !/^1[3-9]\d{9}$/.test(phone)) return sendJson(res, 400, { error: 'bad_phone', message: '手机号格式不正确' });
        try {
          const c = app.db.addContact(authUser.id, { name, phone });
          return sendJson(res, 201, { contact: { name: c.name, phone: c.phone, inBank: Boolean(c.account_id) } });
        } catch (err) {
          if (err.code === 'CONTACT_EXISTS') return sendJson(res, 409, { error: 'contact_exists', message: '该收款人已存在' });
          return sendJson(res, 400, { error: 'contact_failed', message: String(err.message).slice(0, 120) });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          users: app.db.listUsers().length,
          balanceBalanced: app.db.globalBalance() === 0,
          auditIntact: app.audit.verifyChain() === null,
          llm: Boolean(app.llm),
          model: app.llm?.config.model ?? null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/tools') {
        return sendJson(res, 200, { tools: app.registry.list() });
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 30), 200);
        return sendJson(res, 200, { events: app.audit.list(limit) });
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJson(req);
        if (body.userId && body.userId !== authUser.id) {
          return sendJson(res, 403, { error: 'user_mismatch', message: '请求体用户与登录身份不一致' });
        }
        const out = await app.agent.handle({
          userId: authUser.id,
          text: String(body.text ?? ''),
          channel: 'web',
          newDevice: Boolean(body.newDevice),
        });
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && url.pathname === '/api/confirm') {
        const body = await readJson(req);
        if (body.userId && body.userId !== authUser.id) {
          return sendJson(res, 403, { error: 'user_mismatch' });
        }
        const out = await app.agent.confirm({
          userId: authUser.id,
          token: String(body.token ?? ''),
          mfaCode: body.mfaCode == null ? null : String(body.mfaCode),
        });
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        const body = await readJson(req);
        return sendJson(res, 200, app.agent.cancel({ userId: authUser.id }));
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      return sendJson(res, 500, { error: 'internal_error', message: String(err.message).slice(0, 200) });
    }
  });
  server.app = app;
  return server;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendFile(res, file, type) {
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`bank agent web: http://127.0.0.1:${PORT}`);
    console.log(`model: ${process.env.DEEPSEEK_MODEL || 'deepseek-chat'} | llm: ${process.env.DEEPSEEK_API_KEY ? 'on' : 'off'}`);
  });
}
