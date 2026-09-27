import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type MemoryKind = 'decision' | 'fact' | 'idea' | 'note' | 'preference';
export type TaskStatus = 'active' | 'done' | 'failed' | 'cancelled';

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
  status: TaskStatus;
  plan: PlanStep[];
  summary?: string;
  /** Condensed conversation (user prompts + final answers) so follow-ups keep context. */
  history: { role: 'user' | 'assistant'; content: string; at: number }[];
  filesTouched: string[];
  runIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Memory {
  id: string;
  projectId: string | null;
  kind: MemoryKind;
  text: string;
  tags: string[];
  source: 'agent' | 'user';
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
  error?: string;
  reverted?: boolean;
}

interface DB {
  version: 1;
  projects: Project[];
  tasks: Task[];
  memories: Memory[];
  runs: RunRecord[];
}

const MAX_RUNS = 500;
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/**
 * Durable local memory: projects, tasks, decisions/ideas, and run history.
 * A single JSON document with debounced atomic writes — zero native deps, easy to inspect/back up,
 * and plenty fast for a personal brain (thousands of records). Swap for SQLite behind this API if needed.
 */
export class MemoryStore {
  private db: DB;
  private file: string;
  private timer?: NodeJS.Timeout;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'brain.json');
    this.db = this.load();
  }

  private load(): DB {
    try {
      const db = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DB;
      db.projects ??= [];
      db.tasks ??= [];
      db.memories ??= [];
      db.runs ??= [];
      // Runs that were live when the process died are no longer running.
      for (const r of db.runs) if (r.status === 'running') r.status = 'failed';
      return db;
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.file, backup);
        console.error(`[memory] brain.json unreadable, backed up to ${backup}`);
      }
      return { version: 1, projects: [], tasks: [], memories: [], runs: [] };
    }
  }

  private persist() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  // ── projects ────────────────────────────────────────────────
  listProjects() {
    return [...this.db.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  getProject(id: string) {
    return this.db.projects.find((p) => p.id === id);
  }
  findProjectByPath(p: string) {
    const norm = (s: string) => path.resolve(s).toLowerCase();
    return this.db.projects.find((x) => norm(x.path) === norm(p));
  }
  addProject(input: { name: string; path: string; description?: string }): Project {
    const now = Date.now();
    const p: Project = { id: newId('prj'), ...input, createdAt: now, updatedAt: now };
    this.db.projects.push(p);
    this.persist();
    return p;
  }
  updateProject(id: string, patch: Partial<Omit<Project, 'id'>>) {
    const p = this.getProject(id);
    if (!p) return undefined;
    Object.assign(p, patch, { updatedAt: Date.now() });
    this.persist();
    return p;
  }
  removeProject(id: string) {
    this.db.projects = this.db.projects.filter((p) => p.id !== id);
    const taskIds = new Set(this.db.tasks.filter((t) => t.projectId === id).map((t) => t.id));
    this.db.tasks = this.db.tasks.filter((t) => !taskIds.has(t.id));
    this.db.memories = this.db.memories.filter((m) => m.projectId !== id);
    this.db.runs = this.db.runs.filter((r) => r.projectId !== id);
    this.persist();
  }

  // ── tasks ───────────────────────────────────────────────────
  listTasks(projectId?: string | null) {
    const all = projectId === undefined ? this.db.tasks : this.db.tasks.filter((t) => t.projectId === projectId);
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  getTask(id: string) {
    return this.db.tasks.find((t) => t.id === id);
  }
  addTask(projectId: string | null, title: string): Task {
    const now = Date.now();
    const t: Task = { id: newId('tsk'), projectId, title, status: 'active', plan: [], history: [], filesTouched: [], runIds: [], createdAt: now, updatedAt: now };
    this.db.tasks.push(t);
    if (projectId) this.updateProject(projectId, {});
    this.persist();
    return t;
  }
  updateTask(id: string, patch: Partial<Omit<Task, 'id'>>) {
    const t = this.getTask(id);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.persist();
    return t;
  }
  removeTask(id: string) {
    this.db.tasks = this.db.tasks.filter((t) => t.id !== id);
    this.persist();
  }

  // ── memories ────────────────────────────────────────────────
  listMemories(projectId?: string | null) {
    const all = projectId === undefined ? this.db.memories : this.db.memories.filter((m) => m.projectId === projectId);
    return [...all].sort((a, b) => b.createdAt - a.createdAt);
  }
  addMemory(input: Omit<Memory, 'id' | 'createdAt'>): Memory {
    const text = input.text.trim();
    const dup = this.db.memories.find((m) => m.projectId === input.projectId && m.text.toLowerCase() === text.toLowerCase());
    if (dup) return dup;
    const m: Memory = { ...input, text, id: newId('mem'), createdAt: Date.now() };
    this.db.memories.push(m);
    this.persist();
    return m;
  }
  removeMemory(id: string) {
    this.db.memories = this.db.memories.filter((m) => m.id !== id);
    this.persist();
  }

  /**
   * Keyword relevance search (IDF-weighted term overlap + recency). Returns project memories
   * and global ones (projectId=null).
   */
  searchMemories(query: string, opts: { projectId?: string | null; limit?: number } = {}): Memory[] {
    const pool = this.db.memories.filter((m) => opts.projectId === undefined || m.projectId === opts.projectId || m.projectId === null);
    const qTerms = tokenize(query);
    if (!qTerms.length) return pool.slice(-(opts.limit ?? 10)).reverse();
    const df = new Map<string, number>();
    const docs = pool.map((m) => {
      const terms = new Set(tokenize(m.text + ' ' + m.tags.join(' ') + ' ' + m.kind));
      for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
      return { m, terms };
    });
    const N = docs.length || 1;
    const now = Date.now();
    return docs
      .map(({ m, terms }) => {
        let s = 0;
        for (const q of qTerms) if (terms.has(q)) s += Math.log(1 + N / (df.get(q) ?? 1));
        const ageDays = (now - m.createdAt) / 86_400_000;
        return { m, s: s > 0 ? s + 0.3 / (1 + ageDays / 30) + (m.kind === 'decision' ? 0.2 : 0) : 0 };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, opts.limit ?? 10)
      .map((x) => x.m);
  }

  // ── runs ────────────────────────────────────────────────────
  listRuns(filter: { taskId?: string; projectId?: string } = {}) {
    return this.db.runs
      .filter((r) => (!filter.taskId || r.taskId === filter.taskId) && (!filter.projectId || r.projectId === filter.projectId))
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  getRun(id: string) {
    return this.db.runs.find((r) => r.id === id);
  }
  addRun(r: Omit<RunRecord, 'id'>, id = newId('run')): RunRecord {
    const run = { ...r, id };
    this.db.runs.push(run);
    if (this.db.runs.length > MAX_RUNS) this.db.runs.splice(0, this.db.runs.length - MAX_RUNS);
    this.persist();
    return run;
  }
  updateRun(id: string, patch: Partial<RunRecord>) {
    const r = this.getRun(id);
    if (!r) return undefined;
    Object.assign(r, patch);
    this.persist();
    return r;
  }
}

const STOP = new Set('the a an and or of to in on for with is are was were be it this that as at by from we i you use using il lo la le gli un una e o di da del della per con su che non si'.split(' '));

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}
