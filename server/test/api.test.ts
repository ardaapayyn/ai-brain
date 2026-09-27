import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Orchestrator } from '../src/agent/orchestrator.js';
import { createServer } from '../src/api/server.js';
import { EventBus } from '../src/events.js';
import { LLMRouter } from '../src/llm/router.js';
import { MemoryStore } from '../src/memory/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ScriptedLLM, testConfig, tmpDir } from './helpers.js';

async function boot(llmSteps: ConstructorParameters<typeof ScriptedLLM>[0]) {
  const dataDir = tmpDir('brain-api-');
  const config = testConfig(dataDir);
  config.port = 0;
  config.llm = { active: 'scripted', fallbacks: [], providers: {} };
  const bus = new EventBus();
  const memory = new MemoryStore(dataDir);
  const llm = new LLMRouter(config.llm, [new ScriptedLLM(llmSteps)]);
  const orchestrator = new Orchestrator({ config, llm, tools: new ToolRegistry(), memory, bus });
  const { server } = createServer({ config, bus, llm, memory, orchestrator });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  config.port = port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  return { server, port, base, call, orchestrator };
}

test('API: cross-origin and foreign-host requests are rejected', async () => {
  const { server, call, port } = await boot([() => ({ content: 'hi' })]);
  assert.equal((await call('POST', '/api/runs', { prompt: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/status', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/status')).status, 200);
  assert.equal((await call('GET', '/api/status', undefined, { origin: `http://localhost:${port}` })).status, 200);
  // WebSocket from a foreign origin is refused
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' });
    ws.on('error', () => resolve());
    ws.on('open', () => assert.fail('foreign origin websocket must not connect'));
  });
  server.close();
});

test('API: project → run → live events over WebSocket → task stored', async () => {
  const root = tmpDir('brain-proj-');
  fs.writeFileSync(path.join(root, 'main.py'), 'def attack():\n    return 1\n');
  const { server, call, port } = await boot([
    () => ({ toolCalls: [{ name: 'find_symbol', arguments: { name: 'attack' } }] }),
    (req) => ({ content: `Found: ${req.messages.at(-1)!.content.trim()}` }),
  ]);

  const bad = await call('POST', '/api/projects', { path: path.join(root, 'nope') });
  assert.equal(bad.status, 400);
  const { data: project } = await call('POST', '/api/projects', { path: root, name: 'Py' });
  assert.equal(project.name, 'Py');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: any[] = [];
  const finished = new Promise<any>((resolve) =>
    ws.on('message', (m) => {
      const e = JSON.parse(String(m));
      events.push(e);
      if (e.type === 'run.finished') resolve(e);
    }),
  );
  await new Promise((r) => ws.on('open', r));

  const { data: run } = await call('POST', '/api/runs', { prompt: 'where is attack?', projectId: project.id });
  const done = await finished;
  assert.equal(done.status, 'done');
  assert.match(done.summary, /main\.py:1\s+attack/);
  assert.ok(events.some((e) => e.type === 'tool.started' && e.tool === 'find_symbol'));

  const { data: task } = await call('GET', `/api/tasks/${run.taskId}`);
  assert.equal(task.task.status, 'done');
  const { data: graph } = await call('GET', '/api/graph');
  assert.ok(graph.nodes.some((n: any) => n.id === run.taskId && n.parent === project.id));
  const { data: log } = await call('GET', `/api/runs/${run.runId}`);
  assert.ok(log.events.length > 3);

  ws.close();
  server.close();
});

test('API: settings validation', async () => {
  const { server, call } = await boot([() => ({ content: 'hi' })]);
  assert.equal((await call('PUT', '/api/settings', { llm: { active: 'nope' } })).status, 400);
  const { data } = await call('PUT', '/api/settings', { approvals: { shell: 'ask', fileWrite: 'bogus' }, agent: { maxSteps: 12 } });
  assert.equal(data.approvals.shell, 'ask');
  assert.equal(data.approvals.fileWrite, 'auto');
  assert.equal(data.agent.maxSteps, 12);
  server.close();
});
