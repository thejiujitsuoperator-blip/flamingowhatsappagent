import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { findPlanCode, type GymConfig } from './config.js';
import type { HistoryChat } from './types.js';
import { isIsoDate, localDate, localDateTime } from './util.js';

export const OUTCOMES = ['NEW', 'QUALIFIED', 'TRIAL_BOOKED', 'CONVERTED', 'LOST'] as const;

export interface LeadAssessment {
  /** false for personal chats, vendors, spam... Those chats are not imported at all. */
  isGymEnquiry: boolean;
  name: string | null;
  fitnessGoal: string | null;
  /** Plan code from the gym config, or null. */
  preferredPlan: string | null;
  preferredJoinDate: string | null;
  trialInterest: boolean | null;
  trialDate: string | null;
  trialTime: string | null;
  outcome: (typeof OUTCOMES)[number];
  summary: string;
}

export interface LeadExtractor {
  assess(chat: HistoryChat): Promise<LeadAssessment>;
}

const MAX_MESSAGES = 80;
const MAX_CHARS = 15_000;

export function buildTranscript(chat: HistoryChat, timezone: string): string {
  const lines = chat.messages
    .slice(-MAX_MESSAGES)
    .map((m) => `[${localDateTime(timezone, m.timestamp)}] ${m.fromMe ? 'Gym' : 'Customer'}: ${m.text.replace(/\s+/g, ' ')}`);
  let text = lines.join('\n');
  if (text.length > MAX_CHARS) text = `...\n${text.slice(-MAX_CHARS)}`;
  return text;
}

const nullableString = { type: ['string', 'null'] };
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    isGymEnquiry: { type: 'boolean', description: 'true if the customer is asking about joining/using the gym' },
    name: { ...nullableString, description: "Customer's name only if stated in the chat" },
    fitnessGoal: { ...nullableString, description: 'e.g. weight loss, muscle gain' },
    preferredPlan: { ...nullableString, description: 'One of the plan codes, or null' },
    preferredJoinDate: { ...nullableString, description: 'YYYY-MM-DD, or null' },
    trialInterest: { type: ['boolean', 'null'] },
    trialDate: { ...nullableString, description: 'YYYY-MM-DD of an agreed trial session, or null' },
    trialTime: { ...nullableString, description: 'HH:MM (24h) of an agreed trial session, or null' },
    outcome: { type: 'string', enum: [...OUTCOMES] },
    summary: { type: 'string', description: 'One or two sentences for gym staff' },
  },
  required: [
    'isGymEnquiry',
    'name',
    'fitnessGoal',
    'preferredPlan',
    'preferredJoinDate',
    'trialInterest',
    'trialDate',
    'trialTime',
    'outcome',
    'summary',
  ],
};

const ResponseSchema = z.object({
  isGymEnquiry: z.boolean(),
  name: z.string().nullish(),
  fitnessGoal: z.string().nullish(),
  preferredPlan: z.string().nullish(),
  preferredJoinDate: z.string().nullish(),
  trialInterest: z.boolean().nullish(),
  trialDate: z.string().nullish(),
  trialTime: z.string().nullish(),
  outcome: z.enum(OUTCOMES),
  summary: z.string().default(''),
});

function systemPrompt(config: GymConfig, now: Date): string {
  return `You review old WhatsApp chats of the gym "${config.gym.name}" to build its lead list.
Today is ${localDate(config.timezone, now)} (${config.timezone}). Timestamps in the transcript are local time.
Plan codes: ${config.plans.map((p) => `${p.code} (${p.name})`).join(', ')}.

Rules:
- Extract ONLY what is explicitly stated in the chat. Use null when unknown. Never guess names, dates or plans.
- isGymEnquiry=false for personal chats, suppliers, staff, job applicants, spam or anything that is not a (potential) customer.
- Resolve relative dates ("next Monday") against the message timestamp. Dates as YYYY-MM-DD, times as HH:MM 24h.
- outcome:
  NEW = enquired but little is known;
  QUALIFIED = name, fitness goal and a plan or joining date are known;
  TRIAL_BOOKED = a specific trial session was agreed;
  CONVERTED = the chat shows they actually joined/paid for a membership;
  LOST = they clearly said no, chose another gym, or asked not to be contacted.
- summary: what they wanted and where things were left, for gym staff.`;
}

/** Gemini with structured JSON output. */
export class GeminiLeadExtractor implements LeadExtractor {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly config: GymConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async assess(chat: HistoryChat): Promise<LeadAssessment> {
    const transcript = buildTranscript(chat, this.config.timezone);
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await this.ai.models.generateContent({
          model: this.model,
          contents: [{ role: 'user', parts: [{ text: `WhatsApp name: ${chat.name ?? 'unknown'}\n\nTranscript:\n${transcript}` }] }],
          config: {
            systemInstruction: systemPrompt(this.config, this.now()),
            responseMimeType: 'application/json',
            responseJsonSchema: RESPONSE_SCHEMA,
            temperature: 0,
          },
        });
        return sanitizeAssessment(ResponseSchema.parse(JSON.parse(res.text ?? '')), this.config);
      } catch (err) {
        lastError = err;
        const status = (err as { status?: number }).status;
        if (status !== undefined && status !== 429 && status < 500) throw err;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    throw lastError;
  }
}

/** Normalises model output: unknown plan codes, malformed dates and times become null. */
export function sanitizeAssessment(raw: z.infer<typeof ResponseSchema>, config: GymConfig): LeadAssessment {
  const date = (v: string | null | undefined) => (v && isIsoDate(v) ? v : null);
  const clean = (v: string | null | undefined, max: number) => (v?.trim() ? v.trim().slice(0, max) : null);
  return {
    isGymEnquiry: raw.isGymEnquiry,
    name: clean(raw.name, 80),
    fitnessGoal: clean(raw.fitnessGoal, 200),
    preferredPlan: findPlanCode(config, raw.preferredPlan),
    preferredJoinDate: date(raw.preferredJoinDate),
    trialInterest: raw.trialInterest ?? null,
    trialDate: date(raw.trialDate),
    trialTime: raw.trialTime && /^\d{2}:\d{2}$/.test(raw.trialTime) ? raw.trialTime : null,
    outcome: raw.outcome,
    summary: raw.summary.trim().slice(0, 500),
  };
}

const GYM_KEYWORDS =
  /\b(gym|membership|member|fees?|price|pricing|charges?|cost|plan|package|trial|join|joining|timings?|trainer|personal training|pt|workout|weight ?loss|fitness|zumba|yoga|admission|monthly|quarterly|annual)\b/i;

/** --no-llm mode: keyword filter only, every matching chat becomes a NEW lead with no qualification. */
export class KeywordLeadExtractor implements LeadExtractor {
  async assess(chat: HistoryChat): Promise<LeadAssessment> {
    const customerText = chat.messages.filter((m) => !m.fromMe).map((m) => m.text).join('\n');
    return {
      isGymEnquiry: GYM_KEYWORDS.test(customerText),
      name: null,
      fitnessGoal: null,
      preferredPlan: null,
      preferredJoinDate: null,
      trialInterest: null,
      trialDate: null,
      trialTime: null,
      outcome: 'NEW',
      summary: '',
    };
  }
}
