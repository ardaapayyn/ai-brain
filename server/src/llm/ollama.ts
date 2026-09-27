import type { ProviderConfig } from '../config.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, ProviderHealth, PullProgress, ToolCall, ToolSpec } from './types.js';
import { callId, extractTextToolCalls, parseArgs, providerFetch, readLines, splitThinking } from './util.js';

/** Native Ollama provider (/api/chat, streaming NDJSON, structured tool calls). */
export class OllamaProvider implements LLMProvider {
  constructor(readonly id: string, private cfg: ProviderConfig) {}

  get model() {
    return this.cfg.model;
  }
  get contextTokens() {
    return this.cfg.contextTokens ?? 8192;
  }
  private get base() {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  private toOllama(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
    return { role: m.role, content: m.content };
  }

  /** Only models with a switchable reasoning mode accept `think`; others would reject the request. */
  private get think(): boolean | undefined {
    if (this.cfg.think === undefined) return undefined;
    return /^(qwen3(?!-coder)|qwen3\.|deepseek-r1|magistral|cogito)/i.test(this.cfg.model) ? this.cfg.think : undefined;
  }

  private body(messages: ChatMessage[], tools: ToolSpec[] | undefined, extra: Record<string, unknown> = {}) {
    return {
      model: this.cfg.model,
      messages: messages.map((m) => this.toOllama(m)),
      tools: tools?.length ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
      think: this.think,
      keep_alive: this.cfg.keepAlive,
      ...extra,
      // num_ctx must be identical on every call, otherwise Ollama reloads the model
      options: { num_ctx: this.contextTokens, temperature: this.cfg.temperature ?? 0.2, ...((extra.options as object) ?? {}) },
    };
  }

  async isLoaded(): Promise<boolean | undefined> {
    try {
      const res = await fetch(`${this.base}/api/ps`, { signal: AbortSignal.timeout(1500) });
      const data: any = await res.json();
      return (data.models ?? []).some((m: any) => m.name === this.cfg.model || m.model === this.cfg.model || m.name === `${this.cfg.model}:latest`);
    } catch {
      return undefined;
    }
  }

  async warmup(messages: ChatMessage[], tools: ToolSpec[]): Promise<void> {
    await providerFetch(this.id, `${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.body(messages, tools, { stream: false, options: { num_predict: 1 } })),
      signal: AbortSignal.timeout(10 * 60_000),
    }).then((r) => r.text());
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.body(req.messages, req.tools, { stream: true, options: { temperature: req.temperature ?? this.cfg.temperature ?? 0.2 } });
    const res = await providerFetch(this.id, `${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let usage: ChatResponse['usage'];
    for await (const line of readLines(res.body!)) {
      let chunk: any;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(`${this.id}: ${chunk.error}`);
      const msg = chunk.message ?? {};
      if (msg.thinking) {
        thinking += msg.thinking;
        req.onThinking?.(msg.thinking);
      }
      if (msg.content) {
        content += msg.content;
        req.onToken?.(msg.content);
      }
      for (const tc of msg.tool_calls ?? []) {
        toolCalls.push({ id: tc.id ?? callId(), name: tc.function?.name, arguments: parseArgs(tc.function?.arguments) });
      }
      if (chunk.done) usage = { promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count };
    }

    const split = splitThinking(content);
    content = split.content;
    thinking += split.thinking;
    if (toolCalls.length === 0 && req.tools?.length) {
      const parsed = extractTextToolCalls(content, req.tools);
      if (parsed.calls.length) return { content: parsed.rest, thinking, toolCalls: parsed.calls, usage };
    }
    return { content, thinking: thinking || undefined, toolCalls, usage };
  }

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await providerFetch(this.id, `${this.base}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    for await (const line of readLines(res.body!)) {
      let chunk: any;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      onProgress({ status: chunk.status ?? '', completed: chunk.completed, total: chunk.total });
    }
  }

  async listModels(): Promise<string[]> {
    const res = await providerFetch(this.id, `${this.base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const data: any = await res.json();
    return (data.models ?? []).map((m: any) => m.name as string).sort();
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await this.listModels();
      const has = models.some((m) => m === this.cfg.model || m === `${this.cfg.model}:latest`);
      return has
        ? { ok: true, detail: `Ollama ready · ${this.cfg.model}`, models }
        : { ok: false, detail: `Model "${this.cfg.model}" not pulled. Run: ollama pull ${this.cfg.model}`, models };
    } catch (err: any) {
      return { ok: false, detail: `Ollama not reachable at ${this.base} — is it running? (${err.message})` };
    }
  }
}
