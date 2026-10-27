/**
 * 审计日志：结构化 + 哈希链防篡改。
 * 每条记录的 hash = sha256(prev_hash + canonical(payload))，改一条就要改后面全部。
 */

import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class AuditLog {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** 追加一条审计记录，返回写入后的记录 */
  append({ traceId, actor, event, level, detail = {}, at = new Date().toISOString() }) {
    const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get();
    const prevHash = last?.hash ?? 'GENESIS';
    const body = { traceId, actor, event, level: level ?? null, detail, at };
    const hash = sha256(prevHash + canonicalJson(body));
    const res = this.db
      .prepare(
        `INSERT INTO audit_log (trace_id, actor, event, level, detail_json, at, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(traceId, actor, event, level ?? null, canonicalJson(detail), at, prevHash, hash);
    return { seq: Number(res.lastInsertRowid), ...body, prevHash, hash };
  }

  /** 全链校验：返回第一个断链位置，链完整返回 null */
  verifyChain() {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
    let prev = 'GENESIS';
    for (const row of rows) {
      const body = {
        traceId: row.trace_id,
        actor: row.actor,
        event: row.event,
        level: row.level,
        detail: JSON.parse(row.detail_json),
        at: row.at,
      };
      const expect = sha256(prev + canonicalJson(body));
      if (row.prev_hash !== prev || row.hash !== expect) {
        return { brokenAt: row.seq, expected: expect, actual: row.hash };
      }
      prev = row.hash;
    }
    return null;
  }

  list(limit = 50) {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?')
      .all(limit)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail_json) }));
  }
}
