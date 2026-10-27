/**
 * 统一装配：DB + 审计 + 工具 + Agent。server 与 webhook 共用，避免两套逻辑。
 */

import { BankDB } from './db/ledger.mjs';
import { seed } from './db/seed.mjs';
import { AuditLog } from './core/audit.mjs';
import { loadEnvFile } from './core/env.mjs';
import { ToolRegistry } from './tools/registry.mjs';
import { createTools } from './tools/index.mjs';
import { BankAgent } from './agent/loop.mjs';
import { createDeepSeekClient, llmConfig } from './llm/deepseek.mjs';

loadEnvFile();

export function bootstrap({ dbPath = process.env.DB_PATH || 'data/bank.db', withSeed = true, enableLLM = true } = {}) {
  const db = new BankDB(dbPath);
  if (withSeed) seed(db);
  const audit = new AuditLog(db.db);

  const registry = new ToolRegistry({ db, audit });
  for (const tool of createTools(db)) registry.register(tool);

  let llm = null;
  if (enableLLM) {
    const cfg = llmConfig();
    if (cfg.apiKey) llm = createDeepSeekClient(cfg);
  }

  const agent = new BankAgent({ db, audit, registry, llm });
  return { db, audit, registry, agent, llm };
}
