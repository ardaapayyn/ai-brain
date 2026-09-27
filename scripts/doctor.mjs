#!/usr/bin/env node
// Environment check: Node, git, ripgrep, local LLM runtime and model.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const has = (cmd, args = ['--version']) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : undefined;
};

console.log('\n🧠 AI Brain — doctor\n');
const [major, minor] = process.versions.node.split('.').map(Number);
major > 20 || (major === 20 && minor >= 10) ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — serve Node 20.10+ (consigliato 22 LTS)`);
const git = has('git');
git ? ok(git) : warn('git non trovato — gli strumenti Git dell’agente non funzioneranno');
const rg = has('rg');
rg ? ok(`ripgrep: ${rg}`) : warn('ripgrep (rg) non trovato — la ricerca userà il fallback JS (più lento). Windows: winget install BurntSushi.ripgrep.MSVC');
console.log(`  · ${os.cpus()[0]?.model ?? 'CPU'} · ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM · ${os.platform()}`);

let cfg = { llm: { active: 'ollama', providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder:30b' } } } };
const file = process.env.BRAIN_CONFIG ?? path.resolve('brain.config.json');
if (fs.existsSync(file)) {
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const providers = { ...cfg.llm.providers };
  for (const [k, v] of Object.entries(user.llm?.providers ?? {})) providers[k] = { ...providers[k], ...v };
  cfg = { llm: { ...cfg.llm, ...user.llm, providers } };
}
const settings = path.join(process.env.BRAIN_DATA_DIR ?? path.join(os.homedir(), '.ai-brain'), 'settings.json');
if (fs.existsSync(settings)) {
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  if (s.llm?.active) cfg.llm.active = s.llm.active;
  for (const [k, v] of Object.entries(s.llm?.providers ?? {})) cfg.llm.providers[k] = { ...cfg.llm.providers[k], ...v };
}
const p = cfg.llm.providers[cfg.llm.active];
console.log(`\n  Provider attivo: ${cfg.llm.active} (${p.type}) → ${p.baseUrl} · modello ${p.model}`);
try {
  const url = p.type === 'ollama' ? `${p.baseUrl}/api/tags` : `${p.baseUrl}/models`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  const data = await res.json();
  const models = p.type === 'ollama' ? data.models.map((m) => m.name) : data.data.map((m) => m.id);
  ok(`runtime raggiungibile (${models.length} modelli)`);
  if (p.type === 'ollama') {
    models.includes(p.model) || models.includes(`${p.model}:latest`) ? ok(`modello ${p.model} presente`) : bad(`modello ${p.model} mancante → ollama pull ${p.model}`);
    try {
      const ps = await (await fetch(`${p.baseUrl}/api/ps`)).json();
      for (const m of ps.models ?? []) {
        const gpu = m.size ? Math.round((m.size_vram / m.size) * 100) : 0;
        (gpu > 0 ? ok : warn)(`${m.name} caricato: ${gpu}% in VRAM${gpu === 0 ? ' — gira solo su CPU: vedi README → "GPU AMD"' : ''}`);
      }
    } catch {
      /* optional */
    }
  }
} catch (err) {
  bad(`runtime non raggiungibile a ${p.baseUrl} (${err.cause?.code ?? err.message}). Avvia Ollama (o llama-server).`);
}
console.log('');
