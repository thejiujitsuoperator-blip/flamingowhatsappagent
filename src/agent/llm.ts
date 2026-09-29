import { type Content, type FunctionCall, type FunctionDeclaration, GoogleGenAI } from '@google/genai';
import { sleep } from '../utils/rateLimiter.js';

export type { Content, FunctionCall, FunctionDeclaration };

export interface LlmRequest {
  systemInstruction: string;
  contents: Content[];
  tools: FunctionDeclaration[];
}

export interface LlmResponse {
  /** The model turn exactly as returned (must be echoed back verbatim for multi-step tool use). */
  content: Content;
  functionCalls: FunctionCall[];
  text: string;
}

/** Minimal LLM interface so the agent loop can be tested without calling Gemini. */
export interface LlmClient {
  generate(req: LlmRequest): Promise<LlmResponse>;
}

export class GeminiClient implements LlmClient {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.ai.models.generateContent({
          model: this.model,
          contents: req.contents,
          config: {
            systemInstruction: req.systemInstruction,
            tools: req.tools.length ? [{ functionDeclarations: req.tools }] : undefined,
            temperature: 0.3,
            maxOutputTokens: 1024,
          },
        });
        const content = response.candidates?.[0]?.content ?? { role: 'model', parts: [] };
        return {
          content: { role: 'model', parts: content.parts ?? [] },
          functionCalls: response.functionCalls ?? [],
          text: (content.parts ?? [])
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join('')
            .trim(),
        };
      } catch (err) {
        lastError = err;
        const status = (err as { status?: number }).status;
        // Retry rate limits and transient server errors only.
        if (status !== undefined && status !== 429 && status < 500) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}
