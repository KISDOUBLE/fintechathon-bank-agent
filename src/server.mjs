/**
 * Web 渠道：静态页 + JSON API。渠道层只做转发，不做任何业务判定。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bootstrap } from './bootstrap.mjs';

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
        const out = await app.agent.handle({
          userId: body.userId || 'u_1001',
          text: String(body.text ?? ''),
          channel: 'web',
          newDevice: Boolean(body.newDevice),
        });
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && url.pathname === '/api/confirm') {
        const body = await readJson(req);
        const out = await app.agent.confirm({
          userId: body.userId || 'u_1001',
          token: String(body.token ?? ''),
          mfaCode: body.mfaCode == null ? null : String(body.mfaCode),
        });
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        const body = await readJson(req);
        return sendJson(res, 200, app.agent.cancel({ userId: body.userId || 'u_1001' }));
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
