import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Contact } from '../../repositories/contacts.js';
import type { FunctionCall, FunctionDeclaration } from '../llm.js';

export interface ToolContext {
  app: AppContext;
  /** The WhatsApp contact the agent is talking to. Customer tools only ever act on this contact. */
  contact: Contact;
  /** Side effects the message handler needs to know about after the agent finishes. */
  state: { handedOff: boolean };
}

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  handler: (args: unknown, tc: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(tool: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>, tc: ToolContext) => Promise<unknown>;
}): AgentTool {
  return tool as AgentTool;
}

/** Removes JSON-schema keywords Gemini's function declarations do not accept. */
function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'additionalProperties') continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

export function toDeclaration(tool: AgentTool): FunctionDeclaration {
  const decl: FunctionDeclaration = { name: tool.name, description: tool.description };
  if (Object.keys(tool.schema.shape).length) {
    decl.parametersJsonSchema = sanitizeSchema(z.toJSONSchema(tool.schema, { io: 'input' }));
  }
  return decl;
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result: Record<string, unknown>;
}

/** Validates arguments and runs a tool. Errors are returned to the model instead of thrown. */
export async function executeToolCall(
  tools: AgentTool[],
  call: FunctionCall,
  tc: ToolContext,
): Promise<ToolCallRecord> {
  const name = call.name ?? '';
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { name, args: call.args, result: { error: `Unknown tool "${name}"` } };
  const parsed = tool.schema.safeParse(call.args ?? {});
  if (!parsed.success) {
    return {
      name,
      args: call.args,
      result: { error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` },
    };
  }
  try {
    const value = await tool.handler(parsed.data, tc);
    const result =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>)
        : { result: value ?? null };
    return { name, args: parsed.data, result };
  } catch (err) {
    tc.app.logger.error({ err, tool: name }, 'Tool execution failed');
    return { name, args: parsed.data, result: { error: 'Internal error while running this action. Do not retry; apologise and offer to connect the user with staff.' } };
  }
}

export const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
