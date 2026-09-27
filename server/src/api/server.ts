import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { saveSettings, type BrainConfig, type RuntimeSettings } from '../config.js';
import type { EventBus } from '../events.js';
import type { LLMRouter } from '../llm/router.js';
import type { MemoryKind, MemoryStore } from '../memory/store.js';
import type { Orchestrator } from '../agent/orchestrator.js';
import { renderOverview } from '../workspace/indexer.js';
import { systemInfo } from '../system.js';
import { buildGraph } from './graph.js';

export interface ServerDeps {
  config: BrainConfig;
  bus: EventBus;
  llm: LLMRouter;
  memory: MemoryStore;
  orchestrator: Orchestrator;
  staticDir?: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Handler = (req: http.IncomingMessage, params: Record<string, string>, body: any, url: URL) => Promise<unknown> | unknown;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
};

export function createServer(deps: ServerDeps) {
  const { bus, llm, memory, orchestrator } = deps;
  let config = deps.config;
  const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
  const route = (method: string, pattern: string, fn: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, fn });
  };

  // ── security: only the local UI may drive the agent ─────────
  const allowedOrigins = () =>
    new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
  const isLoopbackHost = (host?: string) => !!host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  function checkRequest(req: http.IncomingMessage) {
    // Blocks DNS-rebinding (foreign Host) and cross-site requests (foreign Origin).
    if (config.host === '127.0.0.1' || config.host === 'localhost') {
      if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'Forbidden host');
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin)) throw new HttpError(403, 'Forbidden origin');
  }

  // ── status & settings ───────────────────────────────────────
  route('GET', '/api/status', async () => {
    const health = await llm.health();
    return {
      version: '0.1.0',
      provider: config.llm.active,
      model: llm.model,
      contextTokens: llm.contextTokens,
      llm: health,
      activeRuns: orchestrator.activeRuns(),
      pendingApprovals: orchestrator.approvals.list(),
      platform: process.platform,
    };
  });

  route('GET', '/api/system', () => systemInfo());

  // In-app model download with live progress (model.pull events).
  const pulling = new Set<string>();
  route('POST', '/api/models/pull', (_r, _p, body) => {
    const model = String(body?.model ?? '').trim();
    if (!/^[\w.\-/:]+$/.test(model)) throw new HttpError(400, 'Invalid model name');
    if (!llm.canPull) throw new HttpError(400, `The active provider (${config.llm.active}) cannot download models`);
    if (pulling.has(model)) return { started: false, alreadyRunning: true };
    pulling.add(model);
    let last = 0;
    llm
      .pull(model, (p) => {
        const now = Date.now();
        if (now - last < 250 && p.completed !== p.total) return; // throttle progress events
        last = now;
        bus.emitEvent({ type: 'model.pull', model, status: p.status, completed: p.completed, total: p.total });
      })
      .then(() => bus.emitEvent({ type: 'model.pull', model, status: 'success', done: true }))
      .catch((err) => bus.emitEvent({ type: 'model.pull', model, status: 'error', done: true, error: err.message }))
      .finally(() => pulling.delete(model));
    return { started: true };
  });

  route('GET', '/api/models', async () => {
    try {
      return { models: await llm.listModels() };
    } catch (err: any) {
      return { models: [], error: err.message };
    }
  });

  const publicSettings = () => ({
    llm: {
      active: config.llm.active,
      fallbacks: config.llm.fallbacks,
      providers: Object.fromEntries(Object.entries(config.llm.providers).map(([k, p]) => [k, { ...p, apiKeyEnv: p.apiKeyEnv ? '(env)' : undefined }])),
    },
    approvals: config.approvals,
    agent: config.agent,
  });

  route('GET', '/api/settings', () => publicSettings());
  route('PUT', '/api/settings', (_req, _p, body: RuntimeSettings) => {
    const patch: RuntimeSettings = {};
    if (body.llm?.active) {
      if (!config.llm.providers[body.llm.active]) throw new HttpError(400, `Unknown provider ${body.llm.active}`);
      patch.llm = { active: body.llm.active };
    }
    if (body.llm?.providers) {
      patch.llm = { ...patch.llm, providers: {} };
      for (const [id, p] of Object.entries(body.llm.providers)) {
        if (!config.llm.providers[id]) throw new HttpError(400, `Unknown provider ${id}`);
        const allowed: Record<string, unknown> = {};
        if (typeof p.model === 'string' && p.model.trim()) allowed.model = p.model.trim();
        if (typeof p.baseUrl === 'string' && /^https?:\/\//.test(p.baseUrl)) allowed.baseUrl = p.baseUrl;
        if (Number(p.contextTokens) >= 2048) allowed.contextTokens = Number(p.contextTokens);
        if (p.temperature !== undefined && Number(p.temperature) >= 0) allowed.temperature = Number(p.temperature);
        patch.llm.providers![id] = allowed;
      }
    }
    if (body.approvals) {
      const valid = ['auto', 'ask', 'ask-risky'];
      patch.approvals = {};
      for (const [k, v] of Object.entries(body.approvals)) {
        if (k in config.approvals && valid.includes(v as string)) (patch.approvals as any)[k] = v;
      }
    }
    if (body.agent) {
      patch.agent = {};
      if (Number(body.agent.maxSteps) >= 5) patch.agent.maxSteps = Math.min(Number(body.agent.maxSteps), 200);
      if (typeof body.agent.requireVerification === 'boolean') patch.agent.requireVerification = body.agent.requireVerification;
    }
    config = saveSettings(config, patch);
    llm.reload(config.llm);
    orchestrator.config = config;
    return publicSettings();
  });

  // ── graph ───────────────────────────────────────────────────
  route('GET', '/api/graph', () => buildGraph(memory, (id) => orchestrator.cachedIndex(id), orchestrator.activeRuns()));

  // ── projects ────────────────────────────────────────────────
  route('GET', '/api/projects', () => memory.listProjects());
  route('POST', '/api/projects', async (_r, _p, body) => {
    const raw = String(body?.path ?? '').trim();
    if (!raw) throw new HttpError(400, 'path is required');
    const abs = path.resolve(raw.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new HttpError(400, `Not a folder: ${abs}`);
    const existing = memory.findProjectByPath(abs);
    if (existing) return existing;
    const p = memory.addProject({ name: String(body?.name ?? '').trim() || path.basename(abs), path: abs, description: body?.description });
    orchestrator.getIndex(p.id).then(() => bus.emitEvent({ type: 'graph.changed' })).catch(() => {});
    bus.emitEvent({ type: 'graph.changed' });
    return p;
  });
  route('GET', '/api/projects/:id', async (_r, { id }) => {
    const p = memory.getProject(id);
    if (!p) throw new HttpError(404, 'Project not found');
    let index;
    try {
      const idx = await orchestrator.getIndex(id);
      index = { files: idx.files.length, languages: idx.languages, frameworks: idx.frameworks, testCommand: idx.testCommand, overview: renderOverview(idx, 3000) };
    } catch (err: any) {
      index = { error: err.message };
    }
    return { project: p, tasks: memory.listTasks(id), memories: memory.listMemories(id), index };
  });
  route('PATCH', '/api/projects/:id', (_r, { id }, body) => {
    const p = memory.updateProject(id, {
      ...(body?.name ? { name: String(body.name) } : {}),
      ...(body?.description !== undefined ? { description: String(body.description) } : {}),
    });
    if (!p) throw new HttpError(404, 'Project not found');
    bus.emitEvent({ type: 'graph.changed' });
    return p;
  });
  route('DELETE', '/api/projects/:id', (_r, { id }) => {
    // Only forgets the project in the brain; never touches files on disk.
    memory.removeProject(id);
    bus.emitEvent({ type: 'graph.changed' });
    return { ok: true };
  });
  route('POST', '/api/projects/:id/reindex', async (_r, { id }) => {
    const idx = await orchestrator.getIndex(id, true);
    bus.emitEvent({ type: 'graph.changed' });
    return { files: idx.files.length };
  });

  // Folder autocomplete for the "add project" dialog.
  route('GET', '/api/fs/dirs', (_r, _p, _b, url) => {
    const q = url.searchParams.get('path') ?? '';
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/';
    const input = q.replace(/^~(?=$|[\\/])/, home) || home;
    const endsWithSep = /[\\/]$/.test(input);
    const dir = endsWithSep ? input : path.dirname(input);
    const prefix = endsWithSep ? '' : path.basename(input).toLowerCase();
    try {
      const dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix))
        .slice(0, 30)
        .map((e) => path.join(dir, e.name));
      return { dirs };
    } catch {
      return { dirs: [] };
    }
  });

  // ── tasks & runs ────────────────────────────────────────────
  route('GET', '/api/tasks/:id', (_r, { id }) => {
    const t = memory.getTask(id);
    if (!t) throw new HttpError(404, 'Task not found');
    return { task: t, runs: memory.listRuns({ taskId: id }) };
  });
  route('DELETE', '/api/tasks/:id', (_r, { id }) => {
    if (orchestrator.activeRuns().some((r) => r.taskId === id)) throw new HttpError(409, 'Task is running');
    memory.removeTask(id);
    bus.emitEvent({ type: 'graph.changed' });
    return { ok: true };
  });
  route('POST', '/api/runs', (_r, _p, body) => {
    try {
      return orchestrator.startRun({ prompt: String(body?.prompt ?? ''), projectId: body?.projectId ?? null, taskId: body?.taskId });
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  });
  route('GET', '/api/runs/:id', (_r, { id }) => {
    const run = memory.getRun(id);
    if (!run) throw new HttpError(404, 'Run not found');
    return { run, events: orchestrator.runLog(id) };
  });
  route('POST', '/api/runs/:id/cancel', (_r, { id }) => ({ ok: orchestrator.cancel(id) }));
  route('POST', '/api/runs/:id/revert', (_r, { id }) => {
    try {
      return { restored: orchestrator.revert(id) };
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  });
  route('POST', '/api/approvals/:id', (_r, { id }, body) => {
    const ok = orchestrator.approvals.resolve(id, !!body?.approved, body?.scope === 'run' ? 'run' : 'once');
    if (!ok) throw new HttpError(404, 'No such pending approval');
    return { ok };
  });

  // ── memory ──────────────────────────────────────────────────
  route('GET', '/api/memories', (_r, _p, _b, url) => {
    const pid = url.searchParams.get('projectId');
    const q = url.searchParams.get('q');
    if (q) return memory.searchMemories(q, { projectId: pid ?? undefined, limit: 30 });
    return memory.listMemories(pid === null ? undefined : pid === 'global' ? null : pid);
  });
  route('POST', '/api/memories', (_r, _p, body) => {
    const kinds: MemoryKind[] = ['decision', 'fact', 'idea', 'note', 'preference'];
    const text = String(body?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'text is required');
    const m = memory.addMemory({
      projectId: body?.projectId ?? null,
      kind: kinds.includes(body?.kind) ? body.kind : 'note',
      text,
      tags: Array.isArray(body?.tags) ? body.tags.map(String) : [],
      source: 'user',
    });
    bus.emitEvent({ type: 'memory.added', id: m.id, projectId: m.projectId, kind: m.kind, text: m.text });
    bus.emitEvent({ type: 'graph.changed' });
    return m;
  });
  route('DELETE', '/api/memories/:id', (_r, { id }) => {
    memory.removeMemory(id);
    bus.emitEvent({ type: 'graph.changed' });
    return { ok: true };
  });

  // ── HTTP plumbing ───────────────────────────────────────────
  async function readBody(req: http.IncomingMessage): Promise<any> {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 5_000_000) throw new HttpError(413, 'Body too large');
      chunks.push(c);
    }
    if (!chunks.length) return undefined;
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Expected application/json');
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  function serveStatic(url: URL, res: http.ServerResponse): boolean {
    if (!deps.staticDir || !fs.existsSync(deps.staticDir)) return false;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    let file = path.resolve(deps.staticDir, rel);
    if (!file.startsWith(path.resolve(deps.staticDir))) return false;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(deps.staticDir, 'index.html');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      checkRequest(req);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && serveStatic(url, res)) return;
        return send(404, { error: 'Not found — in development open the Vite UI at http://localhost:5173' });
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(404, { error: 'Not found' });
      const m = r.re.exec(url.pathname)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = await readBody(req);
      const out = await r.fn(req, params, body, url);
      send(200, out ?? { ok: true });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[api]', err);
      send(status, { error: err.message ?? 'Internal error' });
    }
  });

  // ── WebSocket: live event stream + approvals ────────────────
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    try {
      checkRequest(req);
      if (!req.url?.startsWith('/ws')) throw new Error('bad path');
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'hello', activeRuns: orchestrator.activeRuns(), pendingApprovals: orchestrator.approvals.list() }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'approval') orchestrator.approvals.resolve(String(msg.id), !!msg.approved, msg.scope === 'run' ? 'run' : 'once');
        if (msg.type === 'cancel') orchestrator.cancel(String(msg.runId));
      } catch {
        /* ignore malformed client messages */
      }
    });
  });

  bus.onEvent((e) => {
    const data = JSON.stringify(e);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  });

  return { server, wss, get config() { return config; } };
}
