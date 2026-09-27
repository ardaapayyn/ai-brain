import type { ProviderConfig } from '../config.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, ProviderHealth, ToolCall } from './types.js';
import { callId, extractTextToolCalls, parseArgs, providerFetch, readLines, splitThinking } from './util.js';

/**
 * OpenAI-compatible Chat Completions provider.
 * Works with llama.cpp `llama-server --jinja`, LM Studio, vLLM, and — later — cloud APIs
 * (set `apiKeyEnv` to the environment variable holding the key).
 */
export class OpenAICompatProvider implements LLMProvider {
  /** `getKey` resolves the API key at request time (env var or the local secret store). */
  constructor(readonly id: string, private cfg: ProviderConfig, private getKey?: () => string | undefined) {}

  get remote() {
    return !/^https?:\/\/(127\.|localhost|\[::1\]|0\.0\.0\.0)/i.test(this.cfg.baseUrl);
  }

  get model() {
    return this.cfg.model;
  }
  get contextTokens() {
    return this.cfg.contextTokens ?? 8192;
  }
  private get base() {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    const key = (this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined) || this.getKey?.();
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  private toOpenAI(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: this.cfg.model,
      messages: req.messages.map((m) => this.toOpenAI(m)),
      tools: req.tools?.length
        ? req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
        : undefined,
      temperature: req.temperature ?? this.cfg.temperature ?? 0.2,
      stream: true,
      stream_options: { include_usage: true },
    };
    const res = await providerFetch(this.id, `${this.base}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });

    let content = '';
    let thinking = '';
    const partial = new Map<number, { id?: string; name: string; args: string }>();
    let usage: ChatResponse['usage'];

    for await (const line of readLines(res.body!)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(`${this.id}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
      const delta = chunk.choices?.[0]?.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        thinking += reasoning;
        req.onThinking?.(reasoning);
      }
      if (delta.content) {
        content += delta.content;
        req.onToken?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = partial.get(idx) ?? { name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partial.set(idx, cur);
      }
    }

    const toolCalls: ToolCall[] = [...partial.values()]
      .filter((p) => p.name)
      .map((p) => ({ id: p.id ?? callId(), name: p.name, arguments: parseArgs(p.args) }));

    const split = splitThinking(content);
    content = split.content;
    thinking += split.thinking;
    if (toolCalls.length === 0 && req.tools?.length) {
      const parsed = extractTextToolCalls(content, req.tools);
      if (parsed.calls.length) return { content: parsed.rest, thinking, toolCalls: parsed.calls, usage };
    }
    return { content, thinking: thinking || undefined, toolCalls, usage };
  }

  async listModels(): Promise<string[]> {
    const res = await providerFetch(this.id, `${this.base}/models`, { headers: this.headers(), signal: AbortSignal.timeout(4000) });
    const data: any = await res.json();
    return (data.data ?? []).map((m: any) => m.id as string).sort();
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await this.listModels();
      return { ok: true, detail: `${this.id} ready · ${this.cfg.model}`, models };
    } catch (err: any) {
      if (this.remote && !this.getKey?.() && !(this.cfg.apiKeyEnv && process.env[this.cfg.apiKeyEnv])) {
        return { ok: false, detail: `${this.id}: manca la API key — inseriscila in Impostazioni → Modello` };
      }
      return { ok: false, detail: /API key|credito|accesso/.test(err.message) ? err.message.split(' — ')[0] : `${this.id} non raggiungibile a ${this.base} (${err.message})` };
    }
  }
}
