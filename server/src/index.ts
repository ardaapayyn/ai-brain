import path from 'node:path';
import { Orchestrator } from './agent/orchestrator.js';
import { createServer } from './api/server.js';
import { loadConfig, REPO_ROOT } from './config.js';
import { EventBus } from './events.js';
import { LLMRouter } from './llm/router.js';
import { MemoryStore } from './memory/store.js';
import { ToolRegistry } from './tools/registry.js';

async function main() {
  const config = loadConfig();
  const bus = new EventBus();
  const memory = new MemoryStore(config.dataDir);
  const llm = new LLMRouter(config.llm);
  const tools = new ToolRegistry();
  const orchestrator = new Orchestrator({ config, llm, tools, memory, bus });

  const { server } = createServer({
    config,
    bus,
    llm,
    memory,
    orchestrator,
    staticDir: path.join(REPO_ROOT, 'web', 'dist'),
  });

  // Warm project indexes so the 3D graph shows modules right away.
  for (const p of memory.listProjects()) orchestrator.getIndex(p.id).catch(() => {});

  server.listen(config.port, config.host, async () => {
    const health = await llm.health();
    console.log(`\n  🧠 AI Brain server  →  http://${config.host}:${config.port}`);
    console.log(`     data dir         →  ${config.dataDir}`);
    console.log(`     LLM              →  ${config.llm.active} · ${llm.model}  ${health.ok ? '✓' : '✗'} ${health.detail}\n`);
  });

  const shutdown = () => {
    memory.flush();
    for (const r of orchestrator.activeRuns()) orchestrator.cancel(r.id);
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
