import type { BrainEvent, FolderInfo, Graph, Memory, Project, RunRecord, Settings, Status, SystemInfo, Task } from './types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => req<Status>('GET', '/api/status'),
  models: () => req<{ models: string[]; error?: string }>('GET', '/api/models'),
  system: () => req<SystemInfo>('GET', '/api/system'),
  pullModel: (model: string) => req<{ started: boolean }>('POST', '/api/models/pull', { model }),
  settings: () => req<Settings>('GET', '/api/settings'),
  saveSettings: (patch: unknown) => req<Settings>('PUT', '/api/settings', patch),
  graph: () => req<Graph>('GET', '/api/graph'),
  projects: () => req<Project[]>('GET', '/api/projects'),
  addProject: (path: string, name?: string) => req<Project>('POST', '/api/projects', { path, name }),
  project: (id: string) =>
    req<{ project: Project; tasks: Task[]; memories: Memory[]; index: { files?: number; languages?: Record<string, number>; frameworks?: string[]; testCommand?: string; error?: string } }>(
      'GET',
      `/api/projects/${id}`,
    ),
  removeProject: (id: string) => req('DELETE', `/api/projects/${id}`),
  reindex: (id: string) => req<{ files: number }>('POST', `/api/projects/${id}/reindex`),
  discover: () => req<{ projects: FolderInfo[]; scanned: number; ms: number }>('GET', '/api/fs/discover'),
  browse: (path?: string) => req<{ path: string; parent?: string; folders: FolderInfo[]; roots: FolderInfo[] }>('GET', `/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  bulkProjects: (paths: string[]) => req<{ added: Project[]; existing: Project[]; failed: { path: string; error: string }[] }>('POST', '/api/projects/bulk', { paths }),
  dirs: (path: string) => req<{ dirs: string[] }>('GET', `/api/fs/dirs?path=${encodeURIComponent(path)}`),
  task: (id: string) => req<{ task: Task; runs: RunRecord[] }>('GET', `/api/tasks/${id}`),
  removeTask: (id: string) => req('DELETE', `/api/tasks/${id}`),
  startRun: (prompt: string, projectId: string | null, taskId?: string, mode: 'auto' | 'fast' | 'deep' = 'auto') =>
    req<{ runId: string; taskId: string; mode: 'fast' | 'deep'; model: string }>('POST', '/api/runs', { prompt, projectId, taskId, mode }),
  setSecret: (provider: string, apiKey: string | null) =>
    req<{ ok: boolean; last4?: string; health?: { ok: boolean; detail: string } }>('PUT', '/api/secrets', { provider, apiKey }),
  warmup: (mode: 'auto' | 'fast' | 'deep') => req<{ model?: string; skipped?: boolean; error?: string }>('POST', '/api/warmup', { mode }),
  run: (id: string) => req<{ run: RunRecord; events: BrainEvent[] }>('GET', `/api/runs/${id}`),
  cancelRun: (id: string) => req('POST', `/api/runs/${id}/cancel`),
  revertRun: (id: string) => req<{ restored: string[] }>('POST', `/api/runs/${id}/revert`),
  approve: (id: string, approved: boolean, scope: 'once' | 'run' = 'once') => req('POST', `/api/approvals/${id}`, { approved, scope }),
  addMemory: (m: { projectId: string | null; kind: string; text: string }) => req<Memory>('POST', '/api/memories', m),
  removeMemory: (id: string) => req('DELETE', `/api/memories/${id}`),
};

/** Auto-reconnecting event stream. */
export function connectEvents(onEvent: (e: BrainEvent) => void, onConn: (up: boolean) => void) {
  let ws: WebSocket | undefined;
  let retry = 500;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 500;
      onConn(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onConn(false);
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  open();
  return { send: (msg: unknown) => ws?.readyState === 1 && ws.send(JSON.stringify(msg)) };
}
