import type { BrainConfig } from '../config.js';
import type { JsonSchema, ToolSpec } from '../llm/types.js';
import type { MemoryStore, PlanStep } from '../memory/store.js';
import type { Checkpoint } from '../workspace/checkpoint.js';
import type { ProjectIndex } from '../workspace/indexer.js';
import type { Workspace } from '../workspace/workspace.js';

/** Which approval policy governs a tool call. `none` = always allowed (read-only). */
export type RiskClass = 'none' | 'fileWrite' | 'fileDelete' | 'shell' | 'tests' | 'git' | 'network';

/** Groups tools in the UI / 3D scene (each category is a node the pulses fly to). */
export type ToolCategory = 'filesystem' | 'search' | 'terminal' | 'git' | 'tests' | 'web' | 'memory' | 'planning';

export interface ToolContext {
  runId: string;
  taskId: string;
  projectId: string | null;
  workspace: Workspace;
  memory: MemoryStore;
  checkpoint: Checkpoint;
  config: BrainConfig;
  signal: AbortSignal;
  getIndex(): Promise<ProjectIndex>;
  invalidateIndex(): void;
  /** Stream partial output (e.g. terminal) to the UI. */
  onOutput(chunk: string): void;
  setPlan(steps: PlanStep[]): void;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: JsonSchema;
  /** Risk can depend on arguments (e.g. `git status` vs `git commit`). */
  risk: RiskClass | ((args: any) => RiskClass);
  /** For `ask-risky` policies: is this particular call dangerous/non-trivial? */
  isRisky?: (args: any) => boolean;
  /** Highlight in the approval dialog as destructive. */
  isDangerous?: (args: any) => boolean;
  /** One-line human summary for the activity feed. */
  summarize(args: any): string;
  /** Extra detail shown in the approval dialog (diff preview, full command…). */
  approvalDetail?(args: any, ctx: ToolContext): Promise<string> | string;
  execute(args: any, ctx: ToolContext): Promise<ToolResult>;
}

export const toSpec = (t: Tool): ToolSpec => ({ name: t.name, description: t.description, parameters: t.parameters });

export function str(args: any, key: string, required = true): string {
  const v = args?.[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolArgError(`Missing required argument "${key}"`);
    return '';
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function num(args: any, key: string, fallback: number): number {
  const v = Number(args?.[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export class ToolArgError extends Error {}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n… [${s.length - max} chars truncated] …\n\n${s.slice(-tail)}`;
}
