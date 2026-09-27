import type { MemoryStore } from '../memory/store.js';
import type { ProjectIndex } from '../workspace/indexer.js';

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

export const TOOL_CATEGORIES = ['filesystem', 'search', 'terminal', 'git', 'tests', 'web', 'memory', 'planning'] as const;

/** Semantic graph rendered by the 3D UI: brain core, tool "lobes", projects with their modules, tasks and memories. */
export function buildGraph(
  memory: MemoryStore,
  indexOf: (projectId: string) => ProjectIndex | undefined,
  activeRuns: Graph['activeRuns'],
): Graph {
  const nodes: GraphNode[] = [{ id: 'core', type: 'core', label: 'AI Brain', weight: 6 }];
  const edges: [string, string][] = [];
  const link = (a: string, b: string) => edges.push([a, b]);

  for (const c of TOOL_CATEGORIES) {
    nodes.push({ id: `tool:${c}`, type: 'tool', label: c, parent: 'core', weight: 2 });
    link('core', `tool:${c}`);
  }

  const activeTasks = new Set(activeRuns.map((r) => r.taskId));

  for (const p of memory.listProjects()) {
    const tasks = memory.listTasks(p.id);
    nodes.push({ id: p.id, type: 'project', label: p.name, parent: 'core', weight: 4 + Math.min(tasks.length, 20) * 0.1 });
    link('core', p.id);

    const idx = indexOf(p.id);
    for (const d of (idx?.topDirs ?? []).filter((d) => d.name !== '.').slice(0, 10)) {
      const id = `${p.id}:mod:${d.name}`;
      nodes.push({ id, type: 'module', label: d.name, parent: p.id, weight: 1 + Math.min(Math.log10(d.files + 1), 3) });
      link(p.id, id);
    }
    for (const t of tasks.slice(0, 40)) {
      nodes.push({ id: t.id, type: 'task', label: t.title, parent: p.id, status: activeTasks.has(t.id) ? 'running' : t.status, weight: 1.6 });
      link(p.id, t.id);
    }
    for (const m of memory.listMemories(p.id).slice(0, 60)) {
      nodes.push({ id: m.id, type: 'memory', label: m.text.slice(0, 80), kind: m.kind, parent: p.id, weight: 1 });
      link(p.id, m.id);
    }
  }

  for (const t of memory.listTasks(null).slice(0, 30)) {
    nodes.push({ id: t.id, type: 'task', label: t.title, parent: 'core', status: activeTasks.has(t.id) ? 'running' : t.status, weight: 1.4 });
    link('core', t.id);
  }
  for (const m of memory.listMemories(null).slice(0, 60)) {
    nodes.push({ id: m.id, type: 'memory', label: m.text.slice(0, 80), kind: m.kind, parent: 'tool:memory', weight: 1 });
    link('tool:memory', m.id);
  }
  return { nodes, edges, activeRuns };
}
