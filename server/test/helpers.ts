import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, type BrainConfig } from '../src/config.js';
import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from '../src/llm/types.js';

export function tmpDir(prefix = 'brain-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(dataDir: string): BrainConfig {
  const c = defaultConfig();
  c.dataDir = dataDir;
  c.shell.timeoutMs = 60_000;
  return c;
}

type Step = (req: ChatRequest, turn: number) => Partial<ChatResponse> & { toolCalls?: Omit<ToolCall, 'id'>[] | ToolCall[] };

/** Scripted LLM: each chat() call returns the next step. Records every request for assertions. */
export class ScriptedLLM implements LLMProvider {
  readonly id = 'scripted';
  readonly model = 'scripted-model';
  readonly contextTokens = 32000;
  requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private steps: Step[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const step = this.steps[Math.min(this.turn, this.steps.length - 1)];
    const r = step(req, this.turn++);
    if (r.content) req.onToken?.(r.content);
    return {
      content: r.content ?? '',
      toolCalls: (r.toolCalls ?? []).map((c, i) => ({ id: (c as ToolCall).id ?? `c${this.turn}_${i}`, name: c.name, arguments: c.arguments })),
    };
  }
  async health() {
    return { ok: true, detail: 'scripted' };
  }
  async listModels() {
    return [this.model];
  }
}
