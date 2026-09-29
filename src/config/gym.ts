import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Gym knowledge base + automation settings.
 * The agent may ONLY state facts (prices, timings, policies) that exist in this file.
 */
const PlanSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]+$/i, 'plan code must be alphanumeric/underscore/dash'),
  name: z.string(),
  /** Price charged per billing cycle. */
  price: z.number().nonnegative(),
  /** Length of one billing cycle in months (1 = monthly, 3 = quarterly, 12 = yearly). */
  durationMonths: z.number().int().positive(),
  description: z.string().optional(),
  includes: z.array(z.string()).default([]),
});

const GymConfigSchema = z.object({
  gym: z.object({
    name: z.string(),
    address: z.string(),
    mapsUrl: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    website: z.string().optional(),
  }),
  timezone: z.string().default('Asia/Kolkata'),
  currency: z.object({
    code: z.string().default('INR'),
    symbol: z.string().default('₹'),
    locale: z.string().default('en-IN'),
  }).prefault({}),
  timings: z.array(z.object({ days: z.string(), hours: z.string() })),
  holidays: z.string().optional(),
  facilities: z.array(z.string()),
  plans: z.array(PlanSchema).min(1),
  joiningFee: z.number().nonnegative().optional(),
  personalTraining: z
    .object({
      available: z.boolean(),
      details: z.string().optional(),
      packages: z.array(z.object({ name: z.string(), price: z.number(), sessions: z.number().optional() })).default([]),
    })
    .optional(),
  trial: z.object({
    available: z.boolean(),
    price: z.number().nonnegative().default(0),
    durationMinutes: z.number().int().positive().optional(),
    details: z.string().optional(),
    /** Allowed trial booking hours in 24h "HH:MM" local time. */
    earliestTime: z.string().regex(/^\d{2}:\d{2}$/).default('06:00'),
    latestTime: z.string().regex(/^\d{2}:\d{2}$/).default('20:00'),
    /** Days of week (0 = Sunday) on which trials cannot be booked. */
    closedWeekdays: z.array(z.number().int().min(0).max(6)).default([]),
  }),
  policies: z.array(z.string()).default([]),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),

  automation: z
    .object({
      /** Automated messages are only sent within these local hours (24h): quiet from `start` until `end`. */
      quietHours: z
        .object({ start: z.number().int().min(0).max(23).default(21), end: z.number().int().min(0).max(23).default(9) })
        .prefault({}),
      /** Hour of day (local) when the daily payment/lead jobs run. */
      dailyJobHour: z.number().int().min(0).max(23).default(9),
      maxAutomatedPerContactPerDay: z.number().int().positive().default(2),
      paymentReminders: z
        .object({
          daysBefore: z.number().int().positive().default(3),
          /** Overdue reminders are sent once per threshold (days after the due date). */
          overdueDays: z.array(z.number().int().positive()).default([1, 7]),
          templates: z
            .object({
              before: z
                .string()
                .default('Hey {name}, just a heads-up that your gym membership payment of {amount} is due on {dueDate}.'),
              due: z.string().default('Hey {name}, your {amount} membership payment is due today.'),
              overdue: z
                .string()
                .default(
                  "Hey {name}, your membership payment is still pending. Let us know if you've already paid and we'll update it.",
                ),
            })
            .prefault({}),
        })
        .prefault({}),
      leadFollowUps: z
        .object({
          enabled: z.boolean().default(true),
          /** Sent N days after the lead's last reply. The last step is the final follow-up. */
          steps: z
            .array(z.object({ afterDays: z.number().positive(), message: z.string() }))
            .min(1)
            .default([
              { afterDays: 1, message: 'Hi {name}! Just checking in, do you have any other questions about {gymName}?' },
              {
                afterDays: 3,
                message: 'Hi {name}, would you like to book a free trial session at {gymName}? Happy to help you pick a time.',
              },
              {
                afterDays: 7,
                message:
                  "Hi {name}, this is our last check-in. Whenever you're ready to start, just message us here. Reply STOP to opt out.",
              },
            ]),
          /** Leads with no reply this many days after the final follow-up are marked LOST. */
          markLostAfterDays: z.number().int().positive().default(7),
        })
        .prefault({}),
    })
    .prefault({}),

  rateLimits: z
    .object({
      /** Max inbound messages per contact per minute that the AI will answer. */
      inboundPerMinute: z.number().int().positive().default(8),
      /** Minimum gap between any two outbound WhatsApp messages (ms). */
      outboundMinGapMs: z.number().int().nonnegative().default(1200),
      /** Max outbound messages per minute across all contacts. */
      outboundPerMinute: z.number().int().positive().default(30),
    })
    .prefault({}),
});

export type GymConfig = z.infer<typeof GymConfigSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export function parseGymConfig(raw: unknown): GymConfig {
  const parsed = GymConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid gym config:\n${issues}`);
  }
  const codes = new Set<string>();
  for (const p of parsed.data.plans) {
    if (codes.has(p.code)) throw new Error(`Invalid gym config: duplicate plan code "${p.code}"`);
    codes.add(p.code);
  }
  return parsed.data;
}

export function loadGymConfig(path: string): GymConfig {
  const full = resolve(process.cwd(), path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new Error(
      `Gym config not found at ${full}. Copy config/gym.example.json to config/gym.json and fill in your gym's real details.`,
    );
  }
  return parseGymConfig(JSON.parse(text));
}

export function findPlan(config: GymConfig, codeOrName: string): Plan | undefined {
  const q = codeOrName.trim().toLowerCase();
  return (
    config.plans.find((p) => p.code.toLowerCase() === q) ??
    config.plans.find((p) => p.name.toLowerCase() === q) ??
    config.plans.find((p) => p.name.toLowerCase().includes(q))
  );
}
