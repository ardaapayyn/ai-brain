import type { Approval, BrainEvent, Graph, PlanStep, Project, Status } from './types';
import type { Theme } from './scene/palette';

export type TimelineItem =
  | { kind: 'thought'; text: string; streaming: boolean }
  | { kind: 'tool'; callId: string; tool: string; category: string; summary: string; status: 'running' | 'ok' | 'fail'; preview: string; live: string; durationMs?: number; open: boolean }
  | { kind: 'approval'; approval: Approval; resolved?: boolean; approved?: boolean }
  | { kind: 'note'; text: string };

export interface RunView {
  runId: string;
  taskId: string;
  projectId: string | null;
  prompt: string;
  model: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  phase?: string;
  phaseDetail?: string;
  step: number;
  startedAt: number;
  endedAt?: number;
  plan: PlanStep[];
  items: TimelineItem[];
  summary?: string;
  filesTouched: string[];
  reverted?: boolean;
}

export function newRun(e: Extract<BrainEvent, { type: 'run.started' }>, at = Date.now()): RunView {
  return { runId: e.runId, taskId: e.taskId, projectId: e.projectId, prompt: e.prompt, model: e.model, status: 'running', step: 0, startedAt: at, plan: [], items: [], filesTouched: [] };
}

/** Pure-ish reducer shared by live streaming and replay of stored run logs. */
export function applyEvent(run: RunView, e: BrainEvent) {
  const lastThought = () => {
    const last = run.items[run.items.length - 1];
    return last?.kind === 'thought' && last.streaming ? last : undefined;
  };
  const endStream = () => {
    const t = lastThought();
    if (t) t.streaming = false;
  };
  switch (e.type) {
    case 'run.status':
      run.phase = e.phase;
      run.phaseDetail = e.detail;
      run.step = e.step;
      if (e.phase === 'verifying') run.items.push({ kind: 'note', text: '↻ verifica richiesta: l’agente deve testare le modifiche' });
      break;
    case 'llm.token': {
      const t = lastThought();
      if (t) t.text += e.text;
      else run.items.push({ kind: 'thought', text: e.text, streaming: true });
      break;
    }
    case 'llm.message': {
      // authoritative text for this step (also what replays use)
      const t = lastThought();
      if (!e.content.trim()) {
        if (t) run.items.pop();
      } else if (t) {
        t.text = e.content;
        t.streaming = false;
      } else run.items.push({ kind: 'thought', text: e.content, streaming: false });
      break;
    }
    case 'tool.started':
      endStream();
      run.items.push({ kind: 'tool', callId: e.callId, tool: e.tool, category: e.category, summary: e.summary, status: 'running', preview: '', live: '', open: false });
      break;
    case 'tool.output': {
      const it = run.items.find((i) => i.kind === 'tool' && i.callId === e.callId);
      if (it && it.kind === 'tool') {
        it.live = (it.live + e.chunk).slice(-6000);
        it.open = true;
      }
      break;
    }
    case 'tool.finished': {
      const it = run.items.find((i) => i.kind === 'tool' && i.callId === e.callId);
      if (it && it.kind === 'tool') {
        it.status = e.ok ? 'ok' : 'fail';
        it.preview = e.preview;
        it.durationMs = e.durationMs;
        if (e.ok) it.open = false;
      } else {
        run.items.push({ kind: 'tool', callId: e.callId, tool: e.tool, category: '', summary: e.tool, status: e.ok ? 'ok' : 'fail', preview: e.preview, live: '', durationMs: e.durationMs, open: false });
      }
      break;
    }
    case 'plan.updated':
      run.plan = e.steps;
      break;
    case 'approval.requested':
      endStream();
      run.items.push({ kind: 'approval', approval: { id: e.id, runId: e.runId, tool: e.tool, summary: e.summary, detail: e.detail, danger: e.danger } });
      break;
    case 'approval.resolved': {
      const it = run.items.find((i) => i.kind === 'approval' && i.approval.id === e.id);
      if (it && it.kind === 'approval') {
        it.resolved = true;
        it.approved = e.approved;
      }
      break;
    }
    case 'llm.fallback':
      run.items.push({ kind: 'note', text: `modello di riserva: ${e.to}` });
      break;
    case 'run.finished':
      endStream();
      // The final answer is also the last thought — drop the duplicate.
      {
        const last = run.items[run.items.length - 1];
        if (last?.kind === 'thought' && last.text.trim() === e.summary.trim()) run.items.pop();
      }
      run.status = e.status;
      run.summary = e.summary;
      run.filesTouched = e.filesTouched;
      run.endedAt = Date.now();
      run.phase = undefined;
      break;
  }
}

export interface AppState {
  theme: Theme;
  status?: Status;
  connected: boolean;
  graph?: Graph;
  projects: Project[];
  /** Where new prompts go. */
  projectId: string | null;
  /** When set, the next prompt continues this task. */
  followTaskId?: string;
  followTaskTitle?: string;
  runs: Map<string, RunView>;
  /** Run shown in the activity panel. */
  shownRunId?: string;
  selectedNode?: string;
}

function initialTheme(): Theme {
  try {
    const t = localStorage.getItem('brain.theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage unavailable */
  }
  return 'dark'; // the brain is designed black-first; light mode is one click (or T) away
}

export const state: AppState = {
  theme: initialTheme(),
  connected: false,
  projects: [],
  projectId: null,
  runs: new Map(),
};
