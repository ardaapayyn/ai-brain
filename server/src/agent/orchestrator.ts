import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainConfig } from '../config.js';
import type { BrainEvent, EventBus } from '../events.js';
import type { ChatMessage, LLMProvider, ToolCall } from '../llm/types.js';
import type { MemoryStore, PlanStep, Task } from '../memory/store.js';
import { needsApproval, type ToolRegistry } from '../tools/registry.js';
import { ToolArgError, truncate, type ToolContext } from '../tools/types.js';
import { Checkpoint } from '../workspace/checkpoint.js';
import { buildIndex, renderOverview, type ProjectIndex } from '../workspace/indexer.js';
import { SandboxError, Workspace } from '../workspace/workspace.js';
import { ApprovalManager } from './approvals.js';
import { compactMessages } from './context.js';
import { NUDGE_EMPTY, NUDGE_LAST_STEPS, NUDGE_REPEAT, NUDGE_VERIFY, systemPrompt } from './prompts.js';

export interface StartRunInput {
  prompt: string;
  projectId?: string | null;
  taskId?: string;
}

interface ActiveRun {
  id: string;
  taskId: string;
  projectId: string | null;
  abort: AbortController;
  promise: Promise<void>;
}

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
const VERIFY_TOOLS = new Set(['run_tests', 'run_command']);

/**
 * The agent loop. Model-agnostic: it only talks to an LLMProvider and a ToolRegistry,
 * and reports everything it does on the EventBus.
 */
export class Orchestrator {
  readonly approvals: ApprovalManager;
  private active = new Map<string, ActiveRun>();
  private indexes = new Map<string, { idx: ProjectIndex; stale: boolean }>();

  constructor(
    private deps: { config: BrainConfig; llm: LLMProvider; tools: ToolRegistry; memory: MemoryStore; bus: EventBus },
  ) {
    this.approvals = new ApprovalManager(deps.bus);
    this.deps.bus.onEvent((e) => this.log(e));
  }

  get config() {
    return this.deps.config;
  }
  set config(c: BrainConfig) {
    this.deps.config = c;
  }

  activeRuns() {
    return [...this.active.values()].map(({ id, taskId, projectId }) => ({ id, taskId, projectId }));
  }

  // ── workspace & index ───────────────────────────────────────
  workspaceFor(projectId: string | null): Workspace {
    if (projectId) {
      const p = this.deps.memory.getProject(projectId);
      if (!p) throw new Error(`Unknown project ${projectId}`);
      if (!fs.existsSync(p.path)) throw new Error(`Project folder no longer exists: ${p.path}`);
      return new Workspace(p.path);
    }
    const scratch = path.join(this.deps.config.dataDir, 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    return new Workspace(scratch);
  }

  async getIndex(projectId: string | null, force = false): Promise<ProjectIndex> {
    const key = projectId ?? '__scratch';
    const cached = this.indexes.get(key);
    if (cached && !cached.stale && !force && Date.now() - cached.idx.builtAt < 10 * 60_000) return cached.idx;
    const idx = await buildIndex(this.workspaceFor(projectId));
    this.indexes.set(key, { idx, stale: false });
    return idx;
  }

  cachedIndex(projectId: string): ProjectIndex | undefined {
    return this.indexes.get(projectId)?.idx;
  }

  invalidateIndex(projectId: string | null) {
    const c = this.indexes.get(projectId ?? '__scratch');
    if (c) c.stale = true;
  }

  // ── runs ────────────────────────────────────────────────────
  startRun(input: StartRunInput): { runId: string; taskId: string } {
    const { memory } = this.deps;
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('Empty prompt');

    let task: Task | undefined = input.taskId ? memory.getTask(input.taskId) : undefined;
    if (input.taskId && !task) throw new Error(`Unknown task ${input.taskId}`);
    const projectId = task ? task.projectId : input.projectId ?? null;
    if (projectId && !memory.getProject(projectId)) throw new Error(`Unknown project ${projectId}`);
    for (const r of this.active.values()) {
      if (r.projectId === projectId) throw new Error('The agent is already working on this project — wait or cancel the current run.');
    }
    this.workspaceFor(projectId); // validate early

    if (!task) task = memory.addTask(projectId, titleFrom(prompt));
    const runId = 'run_' + randomUUID().replace(/-/g, '').slice(0, 12);
    memory.addRun(
      { taskId: task.id, projectId, prompt, model: this.deps.llm.model, status: 'running', steps: 0, toolCalls: [], startedAt: Date.now() },
      runId,
    );
    memory.updateTask(task.id, { status: 'active', runIds: [...task.runIds, runId] });

    const abort = new AbortController();
    const run: ActiveRun = { id: runId, taskId: task.id, projectId, abort, promise: Promise.resolve() };
    this.active.set(runId, run);
    run.promise = this.execute(run, task.id, prompt).finally(() => {
      this.active.delete(runId);
      this.approvals.clearRun(runId);
    });
    return { runId, taskId: task.id };
  }

  cancel(runId: string): boolean {
    const r = this.active.get(runId);
    if (!r) return false;
    r.abort.abort();
    this.approvals.clearRun(runId);
    return true;
  }

  /** Wait for a run to finish (tests / CLI). */
  async wait(runId: string) {
    await this.active.get(runId)?.promise;
  }

  revert(runId: string): string[] {
    if (this.active.has(runId)) throw new Error('Cannot revert a run that is still in progress');
    const run = this.deps.memory.getRun(runId);
    if (!run) throw new Error('Unknown run');
    const restored = Checkpoint.revert(this.deps.config.dataDir, runId);
    this.deps.memory.updateRun(runId, { reverted: true });
    this.invalidateIndex(run.projectId);
    this.emit({ type: 'graph.changed' });
    return restored;
  }

  runLog(runId: string): BrainEvent[] {
    const file = path.join(this.deps.config.dataDir, 'runs', `${runId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  private log(e: BrainEvent) {
    if (!('runId' in e) || e.type === 'llm.token' || e.type === 'llm.thinking' || e.type === 'tool.output') return;
    const dir = path.join(this.deps.config.dataDir, 'runs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${e.runId}.jsonl`), JSON.stringify({ ...e, at: Date.now() }) + '\n');
  }

  private emit(e: BrainEvent) {
    this.deps.bus.emitEvent(e);
  }

  private async execute(run: ActiveRun, taskId: string, prompt: string) {
    const { memory, llm, tools } = this.deps;
    const cfg = () => this.deps.config;
    const signal = run.abort.signal;
    const task = memory.getTask(taskId)!;
    const project = run.projectId ? memory.getProject(run.projectId) : undefined;
    const toolLog: { tool: string; summary: string; ok: boolean }[] = [];
    let step = 0;
    let finalText = '';
    let status: 'done' | 'failed' | 'cancelled' = 'done';
    let checkpoint: Checkpoint | undefined;

    this.emit({ type: 'run.started', runId: run.id, taskId, projectId: run.projectId, prompt, model: llm.model });
    this.emit({ type: 'graph.changed' });

    try {
      const workspace = this.workspaceFor(run.projectId);
      checkpoint = new Checkpoint(cfg().dataDir, run.id, workspace.root);
      let overview: string | undefined;
      if (project) {
        try {
          overview = renderOverview(await this.getIndex(run.projectId), 2500);
        } catch {
          /* index is an optimization */
        }
      }
      const memories = memory.searchMemories(prompt + ' ' + task.title, { projectId: run.projectId, limit: 8 });
      const shell = process.platform === 'win32' ? (cfg().shell.windows === 'powershell' ? 'PowerShell' : 'cmd.exe') : '/bin/sh';

      let messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt({ project, workspaceRoot: workspace.root, overview, memories, task, shell }) },
        { role: 'user', content: prompt },
      ];

      const ctx: ToolContext = {
        runId: run.id,
        taskId,
        projectId: run.projectId,
        workspace,
        memory,
        checkpoint,
        get config() {
          return cfg();
        },
        signal,
        getIndex: () => this.getIndex(run.projectId),
        invalidateIndex: () => this.invalidateIndex(run.projectId),
        onOutput: () => {},
        setPlan: (steps: PlanStep[]) => {
          memory.updateTask(taskId, { plan: steps });
          this.emit({ type: 'plan.updated', runId: run.id, taskId, steps });
        },
      };

      let modifiedSinceVerify = false;
      let nudgedVerify = false;
      let nudgedEmpty = false;
      let warnedLimit = false;
      let lastCallKey = '';
      let repeatCount = 0;
      const maxSteps = cfg().agent.maxSteps;

      for (step = 1; step <= maxSteps; step++) {
        if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
        if (!warnedLimit && step === maxSteps - 2) {
          warnedLimit = true;
          messages.push({ role: 'user', content: NUDGE_LAST_STEPS });
        }

        this.emit({ type: 'run.status', runId: run.id, phase: 'thinking', step });
        const budget = Math.floor(llm.contextTokens * 0.75) - 1500; // leave room for tools schema + answer
        messages = compactMessages(messages, Math.max(budget, 2000));

        let streamed = false;
        const res = await llm.chat({
          messages,
          tools: tools.specs(),
          signal,
          onToken: (text) => {
            streamed = true;
            this.emit({ type: 'llm.token', runId: run.id, text });
          },
          onThinking: (text) => this.emit({ type: 'llm.thinking', runId: run.id, text }),
        });
        const served = (llm as any).lastServedBy as string | undefined;
        if (served && served !== (llm as any).active?.id) this.emit({ type: 'llm.fallback', runId: run.id, from: (llm as any).active?.id, to: served });

        messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls.length ? res.toolCalls : undefined });
        // Authoritative text for this step: replaces the streamed tokens in the UI (which may have
        // contained <think> blocks or tool calls emitted as text). Empty = drop the streamed bubble.
        if (res.content.trim() || streamed) this.emit({ type: 'llm.message', runId: run.id, content: res.content, step });

        if (!res.toolCalls.length) {
          if (!res.content.trim() && !nudgedEmpty) {
            nudgedEmpty = true;
            messages.push({ role: 'user', content: NUDGE_EMPTY });
            continue;
          }
          if (modifiedSinceVerify && cfg().agent.requireVerification && !nudgedVerify) {
            nudgedVerify = true;
            this.emit({ type: 'run.status', runId: run.id, phase: 'verifying', step, detail: 'Asking the agent to verify its changes' });
            messages.push({ role: 'user', content: NUDGE_VERIFY });
            continue;
          }
          finalText = res.content.trim();
          break;
        }

        for (const call of res.toolCalls) {
          if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
          const key = call.name + JSON.stringify(call.arguments);
          repeatCount = key === lastCallKey ? repeatCount + 1 : 0;
          lastCallKey = key;

          const result = await this.runTool(run, ctx, call, step);
          toolLog.push({ tool: call.name, summary: result.summary, ok: result.ok });
          memory.updateRun(run.id, { steps: step, toolCalls: toolLog });
          let content = result.output;
          if (repeatCount >= 2) content += `\n\n${NUDGE_REPEAT}`;
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });

          if (result.ok && MUTATING_TOOLS.has(call.name)) modifiedSinceVerify = true;
          if (result.executed && VERIFY_TOOLS.has(call.name)) modifiedSinceVerify = false;
        }
        if (step === maxSteps) {
          status = 'failed';
          finalText = `Stopped after reaching the step limit (${maxSteps}). Progress so far is saved in the plan; send a follow-up to continue.`;
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal.aborted) {
        status = 'cancelled';
        finalText = 'Run cancelled by the user.';
      } else {
        status = 'failed';
        finalText = `Error: ${err?.message ?? String(err)}`;
        console.error('[orchestrator]', err);
      }
    }

    const touched = checkpoint?.touched ?? [];
    const current = memory.getTask(taskId)!;
    memory.updateTask(taskId, {
      status: status === 'done' ? 'done' : status,
      summary: finalText.slice(0, 4000),
      filesTouched: [...new Set([...current.filesTouched, ...touched])],
      history: [
        ...current.history,
        { role: 'user' as const, content: prompt, at: Date.now() },
        { role: 'assistant' as const, content: finalText.slice(0, 4000), at: Date.now() },
      ].slice(-20),
    });
    memory.updateRun(run.id, { status, steps: step, toolCalls: toolLog, endedAt: Date.now(), error: status === 'failed' ? finalText : undefined });
    this.emit({ type: 'run.finished', runId: run.id, taskId, status, summary: finalText, filesTouched: touched });
    this.emit({ type: 'graph.changed' });
  }

  private async runTool(run: ActiveRun, ctx: ToolContext, call: ToolCall, step: number): Promise<{ ok: boolean; output: string; summary: string; executed: boolean }> {
    const tool = this.deps.tools.get(call.name);
    const t0 = Date.now();
    const args = call.arguments ?? {};
    let summary = call.name;
    try {
      summary = tool ? safeSummary(() => tool.summarize(args), call.name) : call.name;
      this.emit({ type: 'tool.started', runId: run.id, callId: call.id, tool: call.name, category: tool?.category ?? 'planning', summary, args: previewArgs(args) });
      if (!tool) {
        const names = this.deps.tools.list().map((t) => t.name).join(', ');
        throw new ToolArgError(`Unknown tool "${call.name}". Available tools: ${names}`);
      }
      if ('__invalid_json' in args) throw new ToolArgError(`Arguments were not valid JSON: ${String(args.__invalid_json).slice(0, 200)}`);
      for (const req of tool.parameters.required ?? []) {
        if (args[req] === undefined || args[req] === null) throw new ToolArgError(`Missing required argument "${req}"`);
      }

      if (needsApproval(tool, args, this.deps.config.approvals)) {
        this.emit({ type: 'run.status', runId: run.id, phase: 'waiting_approval', step, detail: summary });
        const detail = tool.approvalDetail ? await tool.approvalDetail(args, ctx) : JSON.stringify(args, null, 2);
        const approved = await this.approvals.request({ runId: run.id, tool: call.name, summary, detail, danger: !!tool.isDangerous?.(args) });
        if (ctx.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        if (!approved) {
          const out = 'The user DENIED this action. Do not retry it; choose another approach or ask the user what they prefer.';
          this.emit({ type: 'tool.finished', runId: run.id, callId: call.id, tool: call.name, ok: false, preview: 'denied by user', durationMs: Date.now() - t0 });
          return { ok: false, output: out, summary, executed: false };
        }
      }

      this.emit({ type: 'run.status', runId: run.id, phase: 'tool', step, detail: summary });
      const toolCtx: ToolContext = Object.create(ctx, {
        onOutput: { value: (chunk: string) => this.emit({ type: 'tool.output', runId: run.id, callId: call.id, chunk }) },
      });
      const res = await tool.execute(args, toolCtx);
      const output = truncate(res.output, this.deps.config.agent.maxToolOutputChars + 2000);
      this.emit({ type: 'tool.finished', runId: run.id, callId: call.id, tool: call.name, ok: res.ok, preview: output.slice(0, 4000), durationMs: Date.now() - t0 });
      if (MUTATING_TOOLS.has(call.name) && res.ok) this.emit({ type: 'graph.changed' });
      return { ok: res.ok, output, summary, executed: true };
    } catch (err: any) {
      if (err?.name === 'AbortError' && ctx.signal.aborted) throw err;
      const known = err instanceof ToolArgError || err instanceof SandboxError;
      const msg = `Error: ${err?.message ?? String(err)}${known ? '' : ' (unexpected tool failure)'}`;
      this.emit({ type: 'tool.finished', runId: run.id, callId: call.id, tool: call.name, ok: false, preview: msg, durationMs: Date.now() - t0 });
      return { ok: false, output: msg, summary, executed: false };
    }
  }
}

function titleFrom(prompt: string): string {
  const first = prompt.split('\n')[0].trim();
  return first.length > 70 ? first.slice(0, 67) + '…' : first;
}

function safeSummary(fn: () => string, fallback: string) {
  try {
    return fn() || fallback;
  } catch {
    return fallback;
  }
}

/** Keep event payloads small (file contents can be huge). */
function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + '…' : v;
  return out;
}
