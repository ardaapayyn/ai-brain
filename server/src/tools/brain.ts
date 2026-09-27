import type { MemoryKind, PlanStep } from '../memory/store.js';
import { num, str, ToolArgError, type Tool } from './types.js';

const KINDS: MemoryKind[] = ['decision', 'fact', 'idea', 'note', 'preference'];
const STATUSES: PlanStep['status'][] = ['pending', 'in_progress', 'done', 'failed'];

export const updatePlan: Tool = {
  name: 'update_plan',
  category: 'planning',
  description:
    'Create or update the step-by-step plan for the current task (shown live to the user). Call it after analysis with all steps, then again whenever a step changes status. Keep exactly one step in_progress.',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered list of steps',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative step description' },
            status: { type: 'string', enum: STATUSES, description: 'pending | in_progress | done | failed' },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['steps'],
  },
  risk: 'none',
  summarize: (a) => `plan (${Array.isArray(a.steps) ? a.steps.length : 0} steps)`,
  async execute(a, ctx) {
    let steps = a.steps;
    if (typeof steps === 'string') {
      try {
        steps = JSON.parse(steps);
      } catch {
        steps = steps.split('\n').filter(Boolean).map((title: string) => ({ title, status: 'pending' }));
      }
    }
    if (!Array.isArray(steps) || !steps.length) throw new ToolArgError('steps must be a non-empty array of {title, status}');
    const clean: PlanStep[] = steps.slice(0, 30).map((s: any) => ({
      title: String(s?.title ?? s?.step ?? s).slice(0, 200),
      status: STATUSES.includes(s?.status) ? s.status : 'pending',
    }));
    ctx.setPlan(clean);
    const done = clean.filter((s) => s.status === 'done').length;
    return { ok: true, output: `Plan updated (${done}/${clean.length} done).` };
  },
};

export const memorySave: Tool = {
  name: 'memory_save',
  category: 'memory',
  description:
    'Save a durable memory for future tasks: architectural decisions, project conventions, user preferences, important facts, ideas. Keep it one or two self-contained sentences. Do not save trivial or temporary info.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS, description: 'decision | fact | idea | note | preference' },
      text: { type: 'string', description: 'The memory, self-contained' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Keywords, e.g. ["combat", "damage"]' },
      global: { type: 'boolean', description: 'true = applies to all projects (e.g. user preference)' },
    },
    required: ['kind', 'text'],
  },
  risk: 'none',
  summarize: (a) => `remember ${a.kind}: ${String(a.text ?? '').slice(0, 60)}`,
  async execute(a, ctx) {
    const kind = KINDS.includes(a.kind) ? (a.kind as MemoryKind) : 'note';
    const m = ctx.memory.addMemory({
      projectId: a.global ? null : ctx.projectId,
      kind,
      text: str(a, 'text').slice(0, 1000),
      tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 8) : [],
      source: 'agent',
    });
    return { ok: true, output: `Saved ${kind} (${m.id}).` };
  },
};

export const memorySearch: Tool = {
  name: 'memory_search',
  category: 'memory',
  description: 'Search long-term memory (past decisions, facts, preferences, previous tasks) for this project.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for' },
      limit: { type: 'integer', description: 'Max results (default 8)' },
    },
    required: ['query'],
  },
  risk: 'none',
  summarize: (a) => `recall "${a.query}"`,
  async execute(a, ctx) {
    const query = str(a, 'query');
    const mems = ctx.memory.searchMemories(query, { projectId: ctx.projectId, limit: num(a, 'limit', 8) });
    const tasks = ctx.memory
      .listTasks(ctx.projectId)
      .filter((t) => t.id !== ctx.taskId && t.summary && query.toLowerCase().split(/\s+/).some((w) => w.length > 2 && (t.title + t.summary).toLowerCase().includes(w)))
      .slice(0, 4);
    const lines = [
      ...mems.map((m) => `[${m.kind}] ${m.text}${m.tags.length ? ` (#${m.tags.join(' #')})` : ''}`),
      ...tasks.map((t) => `[past task: ${t.title}] ${t.summary!.slice(0, 400)}`),
    ];
    return { ok: true, output: lines.length ? lines.join('\n') : 'Nothing relevant in memory.' };
  },
};

export const brainTools = [updatePlan, memorySave, memorySearch];
