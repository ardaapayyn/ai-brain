import { randomUUID } from 'node:crypto';
import type { EventBus } from '../events.js';

interface Pending {
  id: string;
  runId: string;
  tool: string;
  summary: string;
  detail: string;
  danger: boolean;
  resolve: (approved: boolean) => void;
}

/**
 * Human-in-the-loop gate. The orchestrator awaits `request()`; the UI answers via
 * WebSocket/HTTP. "Allow for this run" remembers the tool for the rest of the run
 * (never for dangerous calls).
 */
export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private runAllow = new Map<string, Set<string>>();

  constructor(private bus: EventBus) {}

  request(input: { runId: string; tool: string; summary: string; detail: string; danger: boolean }): Promise<boolean> {
    if (!input.danger && this.runAllow.get(input.runId)?.has(input.tool)) return Promise.resolve(true);
    const id = 'apr_' + randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      this.pending.set(id, { ...input, id, resolve });
      this.bus.emitEvent({ type: 'approval.requested', id, ...input });
    });
  }

  resolve(id: string, approved: boolean, scope: 'once' | 'run' = 'once'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (approved && scope === 'run' && !p.danger) {
      if (!this.runAllow.has(p.runId)) this.runAllow.set(p.runId, new Set());
      this.runAllow.get(p.runId)!.add(p.tool);
    }
    this.bus.emitEvent({ type: 'approval.resolved', id, runId: p.runId, approved });
    p.resolve(approved);
    return true;
  }

  /** Deny everything pending for a run (on cancel) and forget its allow-list. */
  clearRun(runId: string) {
    for (const p of [...this.pending.values()]) if (p.runId === runId) this.resolve(p.id, false);
    this.runAllow.delete(runId);
  }

  list() {
    return [...this.pending.values()].map(({ resolve: _r, ...rest }) => rest);
  }
}
