/**
 * 通用 webhook 渠道（APP / IM 接入的验证载体）。
 * 渠道层只做三件事：收消息、调 Agent、回 JSON。不做权限、不做风控。
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { bootstrap } from '../bootstrap.mjs';

const PORT = Number(process.env.WEBHOOK_PORT || 8788);
const MAX_BODY = 32 * 1024;
// 渠道共享密钥：配置后必须带 x-webhook-secret，未配置仅限本地演示
const SECRET = process.env.WEBHOOK_SECRET || '';

function secretOk(header) {
  if (!SECRET) return true;
  const a = Buffer.from(String(header ?? ''));
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createWebhookChannel(app = bootstrap()) {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      return json(res, 404, { error: 'not_found' });
    }
    if (!secretOk(req.headers['x-webhook-secret'])) {
      return json(res, 401, { error: 'unauthorized_channel' });
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, 400, { error: 'bad_json', message: String(err.message) });
    }

    // 渠道标识与用户绑定属于接入层职责；业务判定全部交给 Agent
    const userId = String(body.userId || 'u_1001');
    const text = String(body.text ?? '');
    const started = Date.now();
    const out = await app.agent.handle({ userId, text, channel: 'webhook', newDevice: Boolean(body.newDevice) });

    return json(res, 200, {
      traceId: out.traceId,
      reply: out.reply,
      level: out.level,
      rules: out.rules,
      status: out.status,
      confirm: out.confirm,
      latencyMs: Date.now() - started,
    });
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
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

if (process.argv[1] && process.argv[1].endsWith('webhook.mjs')) {
  const server = createWebhookChannel();
  server.listen(PORT, () => console.log(`webhook channel: http://127.0.0.1:${PORT}/webhook`));
}
