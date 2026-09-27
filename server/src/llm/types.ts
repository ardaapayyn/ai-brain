/**
 * Provider-agnostic LLM contract. Everything above this layer (orchestrator, tools, UI)
 * only speaks these types, so swapping Ollama for llama.cpp or a cloud model is a config change.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant messages: tool invocations requested by the model */
  toolCalls?: ToolCall[];
  /** tool messages: which call this result answers */
  toolCallId?: string;
  /** tool messages: name of the tool */
  name?: string;
}

/** JSON-schema subset used to describe tool parameters. */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  temperature?: number;
  /** Streamed visible text. */
  onToken?: (text: string) => void;
  /** Streamed reasoning text (models with a thinking channel). */
  onThinking?: (text: string) => void;
}

export interface ChatResponse {
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
  models?: string[];
}

export interface LLMProvider {
  /** Config key, e.g. "ollama". */
  readonly id: string;
  readonly model: string;
  readonly contextTokens: number;
  chat(req: ChatRequest): Promise<ChatResponse>;
  health(): Promise<ProviderHealth>;
  listModels(): Promise<string[]>;
  /** Download a model (runtimes that support it, e.g. Ollama). */
  pull?(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/** Thrown when the provider cannot be reached at all (eligible for fallback). */
export class ProviderUnavailableError extends Error {
  constructor(message: string, readonly providerId: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
