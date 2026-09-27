import { EventEmitter } from 'node:events';
import type { PlanStep } from './memory/store.js';

/** Everything the UI can observe, streamed over the WebSocket. */
export type BrainEvent =
  | { type: 'run.started'; runId: string; taskId: string; projectId: string | null; prompt: string; model: string }
  | { type: 'run.status'; runId: string; phase: 'thinking' | 'tool' | 'waiting_approval' | 'verifying'; step: number; detail?: string }
  | { type: 'llm.token'; runId: string; text: string }
  | { type: 'llm.thinking'; runId: string; text: string }
  | { type: 'llm.message'; runId: string; content: string; step: number }
  | { type: 'tool.started'; runId: string; callId: string; tool: string; category: string; summary: string; args: Record<string, unknown> }
  | { type: 'tool.output'; runId: string; callId: string; chunk: string }
  | { type: 'tool.finished'; runId: string; callId: string; tool: string; ok: boolean; preview: string; durationMs: number }
  | { type: 'plan.updated'; runId: string; taskId: string; steps: PlanStep[] }
  | { type: 'approval.requested'; id: string; runId: string; tool: string; summary: string; detail: string; danger: boolean }
  | { type: 'approval.resolved'; id: string; runId: string; approved: boolean }
  | { type: 'run.finished'; runId: string; taskId: string; status: 'done' | 'failed' | 'cancelled'; summary: string; filesTouched: string[] }
  | { type: 'memory.added'; id: string; projectId: string | null; kind: string; text: string }
  | { type: 'graph.changed' }
  | { type: 'llm.fallback'; runId: string; from: string; to: string };

export class EventBus extends EventEmitter {
  emitEvent(e: BrainEvent) {
    this.emit('event', e);
  }
  onEvent(fn: (e: BrainEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
