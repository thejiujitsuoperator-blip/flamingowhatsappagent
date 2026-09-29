import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Only the parts of the agent's gym config the importer needs. Unknown keys are ignored,
 * so the importer can read the same config/gym.json the WhatsApp agent uses.
 */
const GymConfigSchema = z.looseObject({
  gym: z.looseObject({ name: z.string() }),
  timezone: z.string().default('Asia/Kolkata'),
  plans: z
    .array(z.looseObject({ code: z.string(), name: z.string(), price: z.number().optional(), durationMonths: z.number().optional() }))
    .min(1),
  trial: z.looseObject({ available: z.boolean() }).optional(),
});

export type GymConfig = z.infer<typeof GymConfigSchema>;

export function parseGymConfig(raw: unknown): GymConfig {
  const parsed = GymConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid gym config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function loadGymConfig(path: string): GymConfig {
  const full = resolve(process.cwd(), path);
  try {
    return parseGymConfig(JSON.parse(readFileSync(full, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Gym config not found at ${full}. Point GYM_CONFIG_PATH at the agent's config/gym.json.`);
    }
    throw err;
  }
}

export function findPlanCode(config: GymConfig, codeOrName: string | null | undefined): string | null {
  if (!codeOrName) return null;
  const q = codeOrName.trim().toLowerCase();
  const plan =
    config.plans.find((p) => p.code.toLowerCase() === q) ??
    config.plans.find((p) => p.name.toLowerCase() === q) ??
    config.plans.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
  return plan?.code ?? null;
}
