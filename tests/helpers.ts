import 'dotenv/config';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/agent/llm.js';
import { parseGymConfig, type GymConfig } from '../src/config/gym.js';
import type { AppContext } from '../src/context.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { Outbox } from '../src/services/outbox.js';
import type { MessageTransport } from '../src/services/transport.js';
import { logger } from '../src/utils/logger.js';
import exampleConfig from '../config/gym.example.json' with { type: 'json' };

export const TEST_DB = process.env.TEST_DATABASE_URL;

logger.level = 'silent';

export class FakeTransport implements MessageTransport {
  sent: { jid: string; text: string; id: string }[] = [];
  connected = true;
  private n = 0;
  async sendText(jid: string, text: string) {
    const id = `OUT${++this.n}`;
    this.sent.push({ jid, text, id });
    return id;
  }
  isConnected() {
    return this.connected;
  }
  isOwnMessage(id: string) {
    return this.sent.some((s) => s.id === id);
  }
  textsTo(phone: string) {
    return this.sent.filter((s) => s.jid.startsWith(phone)).map((s) => s.text);
  }
}

type Step = (req: LlmRequest) => Partial<LlmResponse> & { calls?: { name: string; args: Record<string, unknown> }[] };

/** Scripted LLM: each generate() call consumes the next step. */
export class FakeLlm implements LlmClient {
  requests: LlmRequest[] = [];
  constructor(public steps: Step[] = []) {}
  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) return { content: { role: 'model', parts: [{ text: 'ok' }] }, functionCalls: [], text: 'ok' };
    const out = step(req);
    const functionCalls = (out.calls ?? []).map((c, i) => ({ id: `call${i}`, name: c.name, args: c.args }));
    return {
      content: { role: 'model', parts: functionCalls.length ? functionCalls.map((fc) => ({ functionCall: fc })) : [{ text: out.text ?? '' }] },
      functionCalls,
      text: out.text ?? '',
    };
  }
}

export function testConfig(overrides: Partial<GymConfig> = {}): GymConfig {
  const cfg = parseGymConfig(exampleConfig);
  return { ...cfg, rateLimits: { ...cfg.rateLimits, outboundMinGapMs: 0 }, ...overrides };
}

export async function resetDb(): Promise<Pool> {
  const pool = createPool(TEST_DB!);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
  return pool;
}

export function makeContext(pool: Pool, opts: { now?: Date; adminPhones?: string[]; config?: GymConfig } = {}) {
  const transport = new FakeTransport();
  const config = opts.config ?? testConfig();
  const clock = { now: opts.now ?? new Date('2026-10-02T06:00:00Z') }; // 11:30 IST
  const ctx: AppContext = {
    pool,
    config,
    adminPhones: opts.adminPhones ?? ['919000000001'],
    outbox: new Outbox(transport, pool, config, logger),
    logger,
    now: () => clock.now,
  };
  return { ctx, transport, clock };
}
