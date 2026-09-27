// Mirrors of the server's API types (kept minimal on purpose).

export type NodeType = 'core' | 'tool' | 'project' | 'module' | 'task' | 'memory';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  parent?: string;
  status?: string;
  kind?: string;
  weight: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: [string, string][];
  activeRuns: { id: string; taskId: string; projectId: string | null }[];
}

export interface PlanStep {
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface Project {
  id: string;
  name: string;
  path: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  status: 'active' | 'done' | 'failed' | 'cancelled';
  plan: PlanStep[];
  summary?: string;
  history: { role: 'user' | 'assistant'; content: string; at: number }[];
  filesTouched: string[];
  runIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Memory {
  id: string;
  projectId: string | null;
  kind: string;
  text: string;
  tags: string[];
  source: string;
  createdAt: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  projectId: string | null;
  prompt: string;
  model: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  steps: number;
  toolCalls: { tool: string; summary: string; ok: boolean }[];
  startedAt: number;
  endedAt?: number;
  reverted?: boolean;
}

export interface Approval {
  id: string;
  runId: string;
  tool: string;
  summary: string;
  detail: string;
  danger: boolean;
}

export interface Status {
  version: string;
  provider: string;
  model: string;
  contextTokens: number;
  llm: { ok: boolean; detail: string; models?: string[] };
  activeRuns: Graph['activeRuns'];
  pendingApprovals: Approval[];
  platform: string;
}

export type ApprovalPolicy = 'auto' | 'ask' | 'ask-risky';

export interface Settings {
  llm: { active: string; fallbacks: string[]; providers: Record<string, { type: string; baseUrl: string; model: string; contextTokens?: number; temperature?: number }> };
  approvals: Record<'fileWrite' | 'fileDelete' | 'shell' | 'tests' | 'git' | 'network', ApprovalPolicy>;
  agent: { maxSteps: number; maxToolOutputChars: number; requireVerification: boolean };
}

export type BrainEvent =
  | { type: 'hello'; activeRuns: Graph['activeRuns']; pendingApprovals: Approval[] }
  | { type: 'run.started'; runId: string; taskId: string; projectId: string | null; prompt: string; model: string }
  | { type: 'run.status'; runId: string; phase: 'thinking' | 'tool' | 'waiting_approval' | 'verifying'; step: number; detail?: string }
  | { type: 'llm.token'; runId: string; text: string }
  | { type: 'llm.thinking'; runId: string; text: string }
  | { type: 'llm.message'; runId: string; content: string; step: number }
  | { type: 'tool.started'; runId: string; callId: string; tool: string; category: string; summary: string; args: Record<string, unknown> }
  | { type: 'tool.output'; runId: string; callId: string; chunk: string }
  | { type: 'tool.finished'; runId: string; callId: string; tool: string; ok: boolean; preview: string; durationMs: number }
  | { type: 'plan.updated'; runId: string; taskId: string; steps: PlanStep[] }
  | ({ type: 'approval.requested' } & Approval)
  | { type: 'approval.resolved'; id: string; runId: string; approved: boolean }
  | { type: 'run.finished'; runId: string; taskId: string; status: 'done' | 'failed' | 'cancelled'; summary: string; filesTouched: string[] }
  | { type: 'memory.added'; id: string; projectId: string | null; kind: string; text: string }
  | { type: 'graph.changed' }
  | { type: 'llm.fallback'; runId: string; from: string; to: string };
