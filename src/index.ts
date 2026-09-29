import { GeminiClient } from './agent/llm.js';
import { getEnv } from './config/env.js';
import { loadGymConfig } from './config/gym.js';
import type { AppContext } from './context.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { MessageHandler } from './handlers/messageHandler.js';
import { startScheduler } from './scheduler/index.js';
import { Outbox } from './services/outbox.js';
import { logger } from './utils/logger.js';
import { BaileysConnection } from './whatsapp/baileys.js';

async function main() {
  const env = getEnv();
  const config = loadGymConfig(env.GYM_CONFIG_PATH);
  const pool = createPool(env.DATABASE_URL, env.DATABASE_SSL);
  await runMigrations(pool);

  if (!env.ADMIN_PHONES.length) logger.warn('ADMIN_PHONES is empty: admin commands and handoff alerts are disabled');

  const whatsapp = new BaileysConnection(env.WA_AUTH_DIR, logger);
  const outbox = new Outbox(whatsapp, pool, config, logger);
  const ctx: AppContext = { pool, config, adminPhones: env.ADMIN_PHONES, outbox, logger, now: () => new Date() };

  const llm = new GeminiClient(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  const handler = new MessageHandler(ctx, llm, (id) => whatsapp.isOwnMessage(id));
  whatsapp.setMessageListener((msg) => void handler.handle(msg));
  await whatsapp.start();

  const scheduler = env.SCHEDULER_ENABLED ? startScheduler(ctx) : null;
  logger.info({ gym: config.gym.name, model: env.GEMINI_MODEL }, 'Gym WhatsApp agent running');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await scheduler?.stop();
    await whatsapp.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
