import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool,

  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  GYM_CONFIG_PATH: z.string().default('config/gym.json'),
  WA_AUTH_DIR: z.string().default('auth_state'),

  /** Comma separated phone numbers (with country code) allowed to use admin commands. */
  ADMIN_PHONES: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((p) => p.replace(/\D/g, ''))
        .filter(Boolean),
    ),

  /** Set to false to run only the WhatsApp agent without automated messages. */
  SCHEDULER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
