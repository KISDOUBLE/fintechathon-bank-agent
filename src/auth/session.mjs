/**
 * 身份令牌：登录换取 Bearer token，服务端从令牌认人，不再相信前端传来的 userId。
 *
 * 设计取舍：
 *  - 令牌用 HMAC-SHA256 签名，无状态，服务端不存会话表；重启后密钥变化即全部失效。
 *  - 演示账号的 PIN 固定写在种子里（123456），真实系统应换成 OTP / 生物识别。
 *  - 令牌只放在 Authorization 头里，不进 URL、不进日志。
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);

// 每次启动生成新密钥：进程重启后旧令牌自动失效
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');

export function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPin(pin, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function issueToken(userId, ttlMs = TOKEN_TTL_MS) {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iat: Date.now(), exp: Date.now() + ttlMs, jti: randomBytes(8).toString('hex') }),
  ).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expiresIn: Math.floor(ttlMs / 1000) };
}

/** 返回 {ok, userId, reason} */
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };
  const [payload, sig] = token.split('.');
  const expect = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!body?.sub || typeof body.exp !== 'number') return { ok: false, reason: 'bad_payload' };
  if (Date.now() > body.exp) return { ok: false, reason: 'expired' };
  return { ok: true, userId: body.sub };
}

/** 登录失败限速：同一用户 5 次失败锁 60 秒 */
const failures = new Map();

export function recordLoginFailure(userId) {
  const rec = failures.get(userId) ?? { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.until = Date.now() + 60_000;
    rec.count = 0;
  }
  failures.set(userId, rec);
  return rec;
}

export function isLoginLocked(userId) {
  const rec = failures.get(userId);
  return Boolean(rec && rec.until > Date.now());
}

export function clearLoginFailures(userId) {
  failures.delete(userId);
}
