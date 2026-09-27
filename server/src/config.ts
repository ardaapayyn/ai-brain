import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How a class of risky action is gated. */
export type ApprovalPolicy = 'auto' | 'ask' | 'ask-risky';

export interface ProviderConfig {
  /** `ollama` uses the native /api/chat API, `openai` any OpenAI-compatible server (llama.cpp, LM Studio, vLLM, cloud). */
  type: 'ollama' | 'openai';
  baseUrl: string;
  model: string;
  /** Read from this environment variable at runtime; never stored in config files. */
  apiKeyEnv?: string;
  /** Context window requested from the runtime (tokens). */
  contextTokens?: number;
  temperature?: number;
  /** Ollama only: how long the model stays loaded in memory. */
  keepAlive?: string;
}

export interface BrainConfig {
  host: string;
  port: number;
  dataDir: string;
  llm: {
    /** Key of `providers` used first. */
    active: string;
    /** Tried in order when the active provider is unreachable. */
    fallbacks: string[];
    providers: Record<string, ProviderConfig>;
  };
  agent: {
    maxSteps: number;
    maxToolOutputChars: number;
    /** Nudge the model to verify (tests/build) when it edited files but never ran anything. */
    requireVerification: boolean;
  };
  approvals: {
    fileWrite: ApprovalPolicy;
    fileDelete: ApprovalPolicy;
    shell: ApprovalPolicy;
    tests: ApprovalPolicy;
    git: ApprovalPolicy;
    network: ApprovalPolicy;
  };
  shell: {
    timeoutMs: number;
    /** `default` = cmd.exe on Windows, /bin/sh elsewhere. */
    windows: 'default' | 'powershell';
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

/** Honors OLLAMA_HOST like the Ollama CLI does (e.g. "127.0.0.1:11434" or "http://host:port"). */
function ollamaBaseUrl(): string {
  const h = process.env.OLLAMA_HOST;
  if (!h) return 'http://127.0.0.1:11434';
  return (/^https?:\/\//.test(h) ? h : `http://${h}`).replace(/\/+$/, '').replace('://0.0.0.0', '://127.0.0.1');
}

export function defaultConfig(): BrainConfig {
  return {
    host: '127.0.0.1',
    port: 7777,
    dataDir: path.join(os.homedir(), '.ai-brain'),
    llm: {
      active: 'ollama',
      fallbacks: [],
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: ollamaBaseUrl(),
          model: 'qwen3-coder:30b',
          contextTokens: 32768,
          temperature: 0.2,
          keepAlive: '30m',
        },
        'ollama-fast': {
          type: 'ollama',
          baseUrl: ollamaBaseUrl(),
          model: 'qwen3:8b',
          contextTokens: 16384,
          temperature: 0.2,
          keepAlive: '30m',
        },
        'llama-cpp': {
          type: 'openai',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'local',
          contextTokens: 32768,
          temperature: 0.2,
        },
      },
    },
    agent: {
      maxSteps: 40,
      maxToolOutputChars: 12000,
      requireVerification: true,
    },
    approvals: {
      fileWrite: 'auto',
      fileDelete: 'ask',
      shell: 'ask-risky',
      tests: 'auto',
      git: 'ask',
      network: 'auto',
    },
    shell: {
      timeoutMs: 5 * 60_000,
      windows: 'default',
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = (base as any)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v as any);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') return undefined;
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
}

/**
 * Config resolution order (later wins):
 * defaults → brain.config.json (repo root or $BRAIN_CONFIG) → <dataDir>/settings.json (changed from the UI) → env.
 */
export function loadConfig(): BrainConfig {
  let cfg = defaultConfig();
  const file = process.env.BRAIN_CONFIG ?? path.join(REPO_ROOT, 'brain.config.json');
  cfg = deepMerge(cfg, readJson(file));
  if (process.env.BRAIN_DATA_DIR) cfg.dataDir = process.env.BRAIN_DATA_DIR;
  cfg.dataDir = cfg.dataDir.replace(/^~(?=$|[\\/])/, os.homedir());
  cfg = deepMerge(cfg, readJson(settingsFile(cfg)));
  if (process.env.BRAIN_PORT) cfg.port = Number(process.env.BRAIN_PORT);
  if (process.env.BRAIN_HOST) cfg.host = process.env.BRAIN_HOST;
  if (process.env.BRAIN_MODEL) cfg.llm.providers[cfg.llm.active].model = process.env.BRAIN_MODEL;
  return cfg;
}

export function settingsFile(cfg: BrainConfig): string {
  return path.join(cfg.dataDir, 'settings.json');
}

/** Settings the UI is allowed to change at runtime. Persisted to <dataDir>/settings.json. */
export interface RuntimeSettings {
  llm?: { active?: string; providers?: Record<string, Partial<ProviderConfig>> };
  approvals?: Partial<BrainConfig['approvals']>;
  agent?: Partial<BrainConfig['agent']>;
}

export function saveSettings(cfg: BrainConfig, patch: RuntimeSettings): BrainConfig {
  const file = settingsFile(cfg);
  const current = readJson(file) ?? {};
  const next = deepMerge(current, patch as any);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return deepMerge(cfg, patch as any);
}
