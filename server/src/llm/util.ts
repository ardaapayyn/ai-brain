import { randomUUID } from 'node:crypto';
import { ProviderUnavailableError, type ToolCall, type ToolSpec } from './types.js';

export const callId = () => 'call_' + randomUUID().slice(0, 8);

/** Iterate over the lines of a streamed fetch body. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/** fetch() that converts connection failures into ProviderUnavailableError. */
export async function providerFetch(providerId: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ProviderUnavailableError(`${providerId}: cannot reach ${url} (${err?.cause?.code ?? err?.message})`, providerId);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = `${providerId}: HTTP ${res.status} ${text.slice(0, 500)}`;
    // 404 on the model / 5xx means this provider can't serve us → allow fallback.
    if (res.status === 404 || res.status >= 500) throw new ProviderUnavailableError(msg, providerId);
    throw new Error(msg);
  }
  return res;
}

export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    const repaired = tryRepairJson(raw);
    if (repaired) return repaired;
    return { __invalid_json: raw };
  }
}

function tryRepairJson(raw: string): Record<string, unknown> | undefined {
  // Common local-model slips: trailing commas, code fences.
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').replace(/,\s*([}\]])/g, '$1');
  try {
    const v = JSON.parse(cleaned);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fallback for models/runtimes that emit tool calls as plain text instead of structured calls.
 * Supports: <tool_call>{json}</tool_call>, Qwen-coder XML (<function=name><parameter=x>..),
 * and a bare/fenced JSON object {"name": ..., "arguments": {...}} naming a known tool.
 */
export function extractTextToolCalls(text: string, tools: ToolSpec[]): { calls: ToolCall[]; rest: string } {
  const known = new Set(tools.map((t) => t.name));
  const calls: ToolCall[] = [];
  let rest = text;

  const pushJson = (json: string): boolean => {
    const obj = parseArgs(json) as any;
    const name = obj?.name ?? obj?.function?.name ?? obj?.tool;
    if (typeof name !== 'string' || !known.has(name)) return false;
    const args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? obj.args ?? {};
    calls.push({ id: callId(), name, arguments: parseArgs(args) });
    return true;
  };

  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, body: string) => {
    if (body.trim().startsWith('<function=')) return m; // handled below
    return pushJson(body) ? '' : m;
  });

  rest = rest.replace(/(?:<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g, (m, name: string, body: string) => {
    if (!known.has(name)) return m;
    const args: Record<string, unknown> = {};
    for (const p of body.matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
      const v = p[2];
      try {
        args[p[1]] = /^[\[{"]|^-?\d|^(true|false|null)$/.test(v.trim()) ? JSON.parse(v) : v;
      } catch {
        args[p[1]] = v;
      }
    }
    calls.push({ id: callId(), name, arguments: args });
    return '';
  });

  if (calls.length === 0) {
    const fenced = [...rest.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)];
    for (const f of fenced) if (pushJson(f[1])) rest = rest.replace(f[0], '');
    if (calls.length === 0) {
      const trimmed = rest.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}') && pushJson(trimmed)) rest = '';
    }
  }
  return { calls, rest: rest.trim() };
}

/** Some models inline their reasoning as <think>…</think> in the content; move it out of the answer. */
export function splitThinking(content: string): { content: string; thinking: string } {
  let thinking = '';
  const cleaned = content.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_, t: string) => {
    thinking += t;
    return '';
  });
  return { content: cleaned.trim() ? cleaned.replace(/^\s+/, '') : '', thinking };
}

/** Rough token estimate good enough for context budgeting (~3.5 chars/token for code). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);
