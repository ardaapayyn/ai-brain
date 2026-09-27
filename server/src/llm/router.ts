import type { BrainConfig, ProviderConfig } from '../config.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatProvider } from './openai.js';
import { ProviderUnavailableError, type ChatRequest, type ChatResponse, type LLMProvider, type ProviderHealth } from './types.js';

export function createProvider(id: string, cfg: ProviderConfig): LLMProvider {
  switch (cfg.type) {
    case 'ollama':
      return new OllamaProvider(id, cfg);
    case 'openai':
      return new OpenAICompatProvider(id, cfg);
    default:
      throw new Error(`Unknown provider type "${(cfg as any).type}" for "${id}"`);
  }
}

/**
 * The single LLM entry point used by the orchestrator. Routes to the active provider and
 * transparently falls back (in config order) when it is unreachable — e.g. a cloud model
 * as backup for the local one.
 */
export class LLMRouter implements LLMProvider {
  readonly id = 'router';
  private providers = new Map<string, LLMProvider>();
  /** Set when the last call had to fall back; surfaced in the UI. */
  lastServedBy?: string;

  /** `extra` registers pre-built providers (tests, plugins) alongside the configured ones. */
  constructor(private cfg: BrainConfig['llm'], extra: LLMProvider[] = []) {
    for (const p of extra) this.providers.set(p.id, p);
    this.reload(cfg);
  }

  reload(cfg: BrainConfig['llm']) {
    this.cfg = cfg;
    for (const [id, pc] of Object.entries(cfg.providers)) this.providers.set(id, createProvider(id, pc));
    if (!this.providers.has(cfg.active)) throw new Error(`Active provider "${cfg.active}" is not configured`);
  }

  get active(): LLMProvider {
    return this.providers.get(this.cfg.active)!;
  }
  get model() {
    return this.active.model;
  }
  get contextTokens() {
    return this.active.contextTokens;
  }
  get providerIds() {
    return [...this.providers.keys()];
  }

  private chain(): LLMProvider[] {
    const ids = [this.cfg.active, ...this.cfg.fallbacks.filter((f) => f !== this.cfg.active)];
    return ids.map((id) => this.providers.get(id)).filter((p): p is LLMProvider => !!p);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastErr: unknown;
    for (const p of this.chain()) {
      try {
        const res = await p.chat(req);
        this.lastServedBy = p.id;
        return res;
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('No LLM provider configured');
  }

  health(): Promise<ProviderHealth> {
    return this.active.health();
  }
  listModels(): Promise<string[]> {
    return this.active.listModels();
  }

  get canPull() {
    return typeof this.active.pull === 'function';
  }

  pull(model: string, onProgress: Parameters<NonNullable<LLMProvider['pull']>>[1], signal?: AbortSignal) {
    if (!this.active.pull) throw new Error(`${this.active.id} cannot download models — use its own tooling`);
    return this.active.pull(model, onProgress, signal);
  }
}
