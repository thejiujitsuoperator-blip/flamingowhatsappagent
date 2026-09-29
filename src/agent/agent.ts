import type { MessageLog } from '../repositories/messageLogs.js';
import type { Content, LlmClient } from './llm.js';
import { type AgentTool, executeToolCall, type ToolCallRecord, type ToolContext, toDeclaration } from './tools/types.js';

const MAX_STEPS = 6;

export interface AgentResult {
  reply: string;
  toolCalls: ToolCallRecord[];
}

/**
 * Converts stored message logs into Gemini chat history. Consecutive messages from the same side
 * are merged, and automated/staff messages are labelled so the model knows it didn't write them.
 */
export function buildHistory(logs: MessageLog[]): Content[] {
  const contents: Content[] = [];
  for (const log of logs) {
    const role = log.direction === 'INBOUND' ? 'user' : 'model';
    const label = log.source === 'AUTOMATED' ? '[automated message] ' : log.source === 'HUMAN' ? '[sent by staff] ' : '';
    const text = `${label}${log.body}`;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts!.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  // Gemini expects the conversation to start with a user turn.
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(conversation started)' }] });
  return contents;
}

/**
 * Runs the Gemini tool-calling loop: model -> tool calls -> tool results -> model ... -> final text.
 * `history` must end with the user's latest message.
 */
export async function runAgent(opts: {
  llm: LlmClient;
  systemInstruction: string;
  history: Content[];
  tools: AgentTool[];
  toolContext: ToolContext;
}): Promise<AgentResult> {
  const contents = [...opts.history];
  const declarations = opts.tools.map(toDeclaration);
  const toolCalls: ToolCallRecord[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await opts.llm.generate({ systemInstruction: opts.systemInstruction, contents, tools: declarations });
    if (!res.functionCalls.length) {
      return { reply: res.text, toolCalls };
    }
    contents.push(res.content);
    const parts = [];
    for (const call of res.functionCalls) {
      const record = await executeToolCall(opts.tools, call, opts.toolContext);
      toolCalls.push(record);
      parts.push({ functionResponse: { id: call.id, name: record.name, response: record.result } });
    }
    contents.push({ role: 'user', parts });
  }

  // Too many tool steps: ask once more for a final answer without tools.
  const final = await opts.llm.generate({ systemInstruction: opts.systemInstruction, contents, tools: [] });
  return { reply: final.text, toolCalls };
}
