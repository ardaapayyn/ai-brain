#!/usr/bin/env node
/**
 * AI Brain — automatic setup & launcher (no dependencies, Node 20.10+).
 *
 *  1. detects CPU / RAM / GPU (+ real VRAM on Windows)
 *  2. picks the best local models for this machine
 *  3. installs Ollama if missing (winget on Windows) and starts it
 *  4. downloads the models with live progress
 *  5. checks the model really runs on the GPU (auto-fixes the known AMD/Vulkan issue on Windows)
 *  6. installs npm dependencies and builds the app when needed
 *  7. starts the server and opens the brain in the browser
 *
 * Flags: --no-launch  --no-pull  --no-gpu-check  --reconfigure  --port <n>
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const ARGS = new Set(process.argv.slice(2));
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(argValue('--port') ?? process.env.BRAIN_PORT ?? 7777);

// ── pretty console ────────────────────────────────────────────
const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2'), bold = c('1'), violet = c('38;5;141'), cyan = c('38;5;87'), green = c('38;5;114'), yellow = c('38;5;221'), red = c('38;5;203');
// The legacy Windows console (conhost + Consolas) lacks braille/check glyphs; Windows Terminal has them.
const FANCY = !IS_WIN || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode';
const G = FANCY
  ? { step: '◆', ok: '✓', fail: '✗', dot: '·', down: '↓', eye: '◉', full: '█', empty: '░', spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] }
  : { step: '>', ok: '+', fail: 'x', dot: '-', down: 'v', eye: 'o', full: '#', empty: '.', spin: ['|', '/', '-', '\\'] };
let stepNo = 0;
const step = (title) => console.log(`\n${violet(`${G.step} ${String(++stepNo).padStart(2, '0')}`)}  ${bold(title)}`);
const ok = (m) => console.log(`    ${green(G.ok)} ${m}`);
const info = (m) => console.log(`    ${dim(G.dot)} ${m}`);
const warn = (m) => console.log(`    ${yellow('!')} ${m}`);
const fail = (m) => console.log(`    ${red(G.fail)} ${m}`);

function banner() {
  const lines = FANCY
    ? ['', violet('      ▄▀▀▀▄▄▀▀▀▄'), violet('     █  ') + cyan('◉') + violet('    ') + cyan('◉') + violet('  █') + '     ' + bold('A I   ·   B R A I N'), violet('     █   ▀▄▄▀   █') + '     ' + dim('personal AI OS · 100% locale'), violet('      ▀▄▄▄▄▄▄▄▀'), '']
    : ['', '     ' + bold(violet('A I  -  B R A I N')), '     ' + dim('personal AI OS - 100% locale'), ''];
  console.log(lines.join('\n'));
}

function spinner(text) {
  if (!process.stdout.isTTY) {
    info(text);
    return { stop: (final) => final && ok(final) };
  }
  const frames = G.spin;
  let i = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    process.stdout.write(`\r    ${cyan(frames[i++ % frames.length])} ${text} ${dim(`${Math.round((Date.now() - t0) / 1000)}s`)}   `);
  }, 90);
  return {
    stop(final, isWarn) {
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
      if (final) (isWarn ? warn : ok)(final);
    },
  };
}

const fmtBytes = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(question, def = true) {
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`    ${yellow('?')} ${question} ${dim(def ? '[S/n]' : '[s/N]')} `, (a) => {
      rl.close();
      const v = a.trim().toLowerCase();
      resolve(v ? v.startsWith('s') || v.startsWith('y') : def);
    }),
  );
}

// ── helpers ───────────────────────────────────────────────────
const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout ?? 15000, windowsHide: true, maxBuffer: 4_000_000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') }),
    );
  });

const which = (cmd) => {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : undefined;
};

function refreshWindowsPath() {
  if (!IS_WIN) return;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status === 0 && r.stdout.trim()) process.env.Path = process.env.PATH = r.stdout.trim();
}

async function winget(id, label) {
  if (!IS_WIN || !which('winget')) return false;
  const s = spinner(`Installo ${label} con winget…`);
  const r = await run('winget', ['install', '-e', '--id', id, '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { timeout: 15 * 60_000 });
  refreshWindowsPath();
  s.stop(r.ok ? `${label} installato` : `${label}: installazione non riuscita (${(r.out + r.err).trim().split('\n').pop()})`, !r.ok);
  return r.ok;
}

async function http(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(opts.timeout ?? 5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};

// ── 1. hardware ───────────────────────────────────────────────
async function detectGpus() {
  if (IS_WIN) {
    const ps = `$ErrorActionPreference='SilentlyContinue';
      $r = Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' |
        Where-Object { $_.DriverDesc } | ForEach-Object { [pscustomobject]@{ name = $_.DriverDesc; vram = [long]($_.'HardwareInformation.qwMemorySize') } };
      if (-not $r) { $r = Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = $_.Name; vram = [long]$_.AdapterRAM } } };
      $r | ConvertTo-Json -Compress`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    try {
      const d = JSON.parse(r.out);
      const seen = new Set();
      return (Array.isArray(d) ? d : [d])
        .filter((g) => g?.name && !/basic display|remote|virtual|parsec/i.test(g.name) && !seen.has(g.name) && seen.add(g.name))
        .map((g) => ({ name: g.name, vramGB: g.vram > 0 ? Math.round((g.vram / 2 ** 30) * 10) / 10 : 0 }));
    } catch {
      return [];
    }
  }
  if (process.platform === 'darwin') return [{ name: 'Apple GPU (memoria unificata)', vramGB: 0 }];
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (nv.ok && nv.out.trim())
    return nv.out
      .trim()
      .split('\n')
      .map((l) => {
        const [name, mem] = l.split(',').map((s) => s.trim());
        return { name, vramGB: Math.round(Number(mem) / 102.4) / 10 };
      });
  const l = await run('lspci', []);
  return l.out
    .split('\n')
    .filter((x) => /VGA|3D controller/.test(x))
    .map((x) => ({ name: x.replace(/^.*?: /, ''), vramGB: 0 }));
}

// Keep in sync with server/src/system.ts → recommend()
function recommend(ramGB, vramGB) {
  if (ramGB >= 48) return { main: 'qwen3-coder:30b', fast: vramGB >= 6 ? 'qwen3:8b' : 'qwen3:4b', contextTokens: 32768 };
  if (ramGB >= 30) return { main: 'qwen3-coder:30b', fast: vramGB >= 6 ? 'qwen3:8b' : 'qwen3:4b', contextTokens: 16384 };
  if (ramGB >= 22 || vramGB >= 12) return { main: 'qwen3:14b', fast: 'qwen3:4b', contextTokens: 16384 };
  if (ramGB >= 12 || vramGB >= 6) return { main: 'qwen3:8b', fast: 'qwen3:4b', contextTokens: 12288 };
  return { main: 'qwen3:4b', contextTokens: 8192 };
}

// ── 3-4. Ollama ───────────────────────────────────────────────
const OLLAMA = (() => {
  const h = process.env.OLLAMA_HOST;
  if (!h) return 'http://127.0.0.1:11434';
  const u = /^https?:\/\//.test(h) ? h : `http://${h}`;
  return u.replace(/\/+$/, '').replace('://0.0.0.0', '://127.0.0.1');
})();

function findOllama() {
  const onPath = which('ollama');
  if (onPath) return onPath;
  const candidates = IS_WIN
    ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'), 'C:\\Program Files\\Ollama\\ollama.exe']
    : ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'];
  return candidates.find((p) => p && fs.existsSync(p));
}

async function ollamaUp() {
  try {
    await http(`${OLLAMA}/api/version`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

let ownOllama; // the `ollama serve` we started (so we can restart it)

function startOllama(bin, dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'ollama.log'), 'a');
  ownOllama = spawn(bin, ['serve'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION ?? '1',
      OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE ?? 'q8_0',
      OLLAMA_VULKAN: process.env.OLLAMA_VULKAN ?? '1',
    },
  });
  ownOllama.unref();
}

async function waitOllama(seconds = 40) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await ollamaUp()) return true;
    await sleep(500);
  }
  return false;
}

async function stopAllOllama() {
  if (IS_WIN) {
    await run('taskkill', ['/F', '/IM', 'ollama app.exe']);
    await run('taskkill', ['/F', '/IM', 'ollama.exe']);
  } else {
    await run('pkill', ['-x', 'ollama']);
  }
  for (let i = 0; i < 20 && (await ollamaUp()); i++) await sleep(300);
}

async function installedModels() {
  const data = await (await http(`${OLLAMA}/api/tags`)).json();
  return new Set((data.models ?? []).flatMap((m) => [m.name, m.name.replace(/:latest$/, '')]));
}

async function pullModel(model) {
  const res = await fetch(`${OLLAMA}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastDraw = 0;
  const samples = [];
  const draw = (p, force) => {
    const now = Date.now();
    if (!force && now - lastDraw < 150) return;
    lastDraw = now;
    if (!process.stdout.isTTY) return;
    if (p.total && p.completed !== undefined) {
      samples.push([now, p.completed]);
      while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
      const [t0, b0] = samples[0];
      const speed = now > t0 ? ((p.completed - b0) / (now - t0)) * 1000 : 0;
      const pct = p.completed / p.total;
      const width = 26;
      const filled = Math.round(pct * width);
      const bar = violet(G.full.repeat(filled)) + dim(G.empty.repeat(width - filled));
      const eta = speed > 0 ? Math.round((p.total - p.completed) / speed) : 0;
      const etaS = eta > 90 ? `${Math.round(eta / 60)}m` : `${eta}s`;
      process.stdout.write(`\r\x1b[2K    ${cyan(G.down)} ${bold(model)}  ${bar} ${String(Math.round(pct * 100)).padStart(3)}%  ${dim(`${fmtBytes(p.completed)}/${fmtBytes(p.total)} · ${fmtBytes(speed)}/s · ${etaS}`)}`);
    } else {
      process.stdout.write(`\r\x1b[2K    ${cyan(G.down)} ${bold(model)}  ${dim(p.status)}`);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const p = JSON.parse(line);
      if (p.error) throw new Error(p.error);
      draw(p);
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
}

/** Load the model once (also pre-warms it) and report how much sits in VRAM. */
async function gpuShare(model, contextTokens) {
  await http(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', keep_alive: '30m', options: { num_ctx: contextTokens } }),
    timeout: 10 * 60_000,
  });
  const ps = await (await http(`${OLLAMA}/api/ps`)).json();
  const m = (ps.models ?? []).find((x) => x.name === model || x.model === model || x.name === `${model}:latest`);
  if (!m || !m.size) return undefined;
  return Math.round((m.size_vram / m.size) * 100);
}

// ── 6. npm ────────────────────────────────────────────────────
function npm(args, label) {
  const s = spinner(label);
  const r = IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd: ROOT, encoding: 'utf8', shell: true, windowsHide: true, maxBuffer: 50_000_000 })
    : spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 50_000_000 });
  if (r.status !== 0) {
    s.stop();
    fail(`${label} non riuscito`);
    console.log(dim((r.stdout + r.stderr).trim().split('\n').slice(-25).join('\n')));
    process.exit(1);
  }
  s.stop(label.replace(/…$/, '') + ' — fatto');
}

function newest(dir) {
  let t = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}
const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);

// ── 7. launch ─────────────────────────────────────────────────
function openBrowser(url) {
  const [cmd, args] = IS_WIN ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => info(`Apri il browser su ${url}`));
    child.unref();
  } catch {
    /* headless */
  }
}

async function brainRunning() {
  try {
    const s = await (await http(`http://127.0.0.1:${PORT}/api/status`, { timeout: 1500 })).json();
    return !!s.version;
  } catch {
    return false;
  }
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  banner();
  const t0 = Date.now();
  const configFile = process.env.BRAIN_CONFIG ?? path.join(ROOT, 'brain.config.json');
  const userCfg = readJson(configFile);
  const dataDir = (process.env.BRAIN_DATA_DIR ?? userCfg?.dataDir ?? path.join(os.homedir(), '.ai-brain')).replace(/^~(?=$|[\\/])/, os.homedir());
  const stateFile = path.join(dataDir, 'setup-state.json');
  const state = readJson(stateFile) ?? {};

  if (!ARGS.has('--no-launch') && (await brainRunning())) {
    ok(`AI Brain è già in esecuzione → http://127.0.0.1:${PORT}`);
    openBrowser(`http://127.0.0.1:${PORT}`);
    return;
  }

  // 1 ─ hardware
  step('Rilevo il tuo hardware');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 10)) {
    fail(`Node ${process.versions.node}: serve la versione 20.10 o superiore (consigliata 22 LTS)`);
    process.exit(1);
  }
  const ramGB = Math.round(os.totalmem() / 2 ** 30);
  const gpus = await detectGpus();
  const vramGB = Math.max(0, ...gpus.map((g) => g.vramGB || 0));
  ok(`${os.cpus()[0]?.model?.trim() ?? 'CPU'} ${dim(`· ${os.cpus().length} thread`)}`);
  ok(`${ramGB} GB RAM`);
  if (gpus.length) for (const g of gpus) ok(`${g.name}${g.vramGB ? dim(` · ${g.vramGB} GB VRAM`) : ''}`);
  else warn('Nessuna GPU rilevata: il modello girerà su CPU');
  const isAmd = gpus.some((g) => /amd|radeon/i.test(g.name));

  // 2 ─ models
  step('Scelgo i modelli migliori per questo PC');
  const rec = recommend(ramGB, vramGB);
  const settings = readJson(path.join(dataDir, 'settings.json')) ?? {};
  const autoCfg = !userCfg || userCfg.$generated || ARGS.has('--reconfigure');
  if (autoCfg) {
    const cfg = {
      $generated: 'Creato da scripts/setup.mjs in base al tuo hardware. Rimuovi questa riga per impedire che il setup lo aggiorni.',
      ...(userCfg && !ARGS.has('--reconfigure') ? userCfg : {}),
      llm: {
        ...(userCfg?.llm ?? {}),
        active: userCfg?.llm?.active ?? 'ollama',
        providers: {
          ...(userCfg?.llm?.providers ?? {}),
          ollama: { ...(userCfg?.llm?.providers?.ollama ?? {}), model: rec.main, contextTokens: rec.contextTokens },
          ...(rec.fast ? { 'ollama-fast': { ...(userCfg?.llm?.providers?.['ollama-fast'] ?? {}), model: rec.fast, contextTokens: 16384 } } : {}),
        },
      },
    };
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  }
  const effective = { ...(readJson(configFile)?.llm?.providers ?? {}) };
  for (const [k, v] of Object.entries(settings.llm?.providers ?? {})) effective[k] = { ...effective[k], ...v };
  const mainModel = effective.ollama?.model ?? rec.main;
  const fastModel = effective['ollama-fast']?.model ?? rec.fast;
  const ctx = effective.ollama?.contextTokens ?? rec.contextTokens;
  ok(`Principale: ${bold(mainModel)} ${dim(`· contesto ${ctx.toLocaleString('it-IT')} token`)}`);
  if (fastModel && fastModel !== mainModel) ok(`Veloce:     ${bold(fastModel)}`);
  if (!autoCfg) info(dim('brain.config.json personalizzato: uso i modelli che hai scelto'));

  // 3 ─ tools
  step('Controllo gli strumenti');
  const git = which('git');
  git ? ok('Git') : (await winget('Git.Git', 'Git')) || warn('Git mancante: gli strumenti Git dell’agente saranno disattivati');
  which('rg') ? ok('ripgrep (ricerca veloce)') : (await winget('BurntSushi.ripgrep.MSVC', 'ripgrep')) || info('ripgrep non disponibile: userò la ricerca integrata');

  // 4 ─ Ollama
  step('Preparo il motore AI locale (Ollama)');
  let bin = findOllama();
  if (!bin && !(await ollamaUp())) {
    if (IS_WIN) {
      await winget('Ollama.Ollama', 'Ollama');
      bin = findOllama();
    } else if (process.platform === 'linux' && (await ask('Ollama non è installato. Lo installo con lo script ufficiale (curl https://ollama.com/install.sh | sh)?'))) {
      spawnSync('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: 'inherit' });
      bin = findOllama();
    } else if (process.platform === 'darwin' && which('brew')) {
      spawnSync('brew', ['install', 'ollama'], { stdio: 'inherit' });
      bin = findOllama();
    }
    if (!bin) {
      fail('Ollama non trovato. Installalo da https://ollama.com/download e rilancia.');
      process.exit(1);
    }
  }
  if (bin) ok(`Ollama: ${dim(bin)}`);
  if (!(await ollamaUp())) {
    const s = spinner('Avvio Ollama…');
    startOllama(bin, dataDir);
    const up = await waitOllama();
    s.stop(up ? 'Ollama in esecuzione' : undefined);
    if (!up) {
      fail(`Ollama non risponde su ${OLLAMA}. Log: ${path.join(dataDir, 'ollama.log')}`);
      process.exit(1);
    }
  } else ok('Ollama già in esecuzione');
  const version = (await (await http(`${OLLAMA}/api/version`)).json()).version;
  info(dim(`versione ${version}`));

  // 5 ─ downloads
  step('Scarico i modelli');
  const wanted = [...new Set([mainModel, fastModel].filter(Boolean))];
  if (ARGS.has('--no-pull')) info('saltato (--no-pull)');
  else {
    const have = await installedModels();
    for (const m of wanted) {
      if (have.has(m)) {
        ok(`${m} ${dim('già presente')}`);
        continue;
      }
      info(`${m}: download in corso ${dim('(la prima volta può richiedere un po’ — puoi riprendere se si interrompe)')}`);
      try {
        await pullModel(m);
        ok(`${m} scaricato`);
      } catch (err) {
        fail(`${m}: ${err.message}`);
        if (m === mainModel) process.exit(1);
      }
    }
  }

  // 6 ─ GPU check
  step('Verifico che il modello usi la GPU');
  const alreadyChecked = state.gpuCheck && state.gpuCheck.version === version && state.gpuCheck.model === mainModel && state.gpuCheck.share > 0;
  if (ARGS.has('--no-gpu-check')) info('saltato (--no-gpu-check)');
  else if (!gpus.length) info('nessuna GPU dedicata: salto');
  else if (alreadyChecked) {
    ok(`${state.gpuCheck.share}% del modello in VRAM ${dim('(verificato in precedenza)')}`);
    gpuShare(mainModel, ctx).catch(() => {}); // pre-warm in background
  } else {
    let s = spinner(`Carico ${mainModel} in memoria (la prima volta richiede un po’)…`);
    let share = await gpuShare(mainModel, ctx).catch(() => undefined);
    s.stop();
    const bundled = IS_WIN ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'lib', 'ollama', 'vulkan', 'vulkan-1.dll') : '';
    const systemLoader = IS_WIN ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'vulkan-1.dll') : '';
    if (share === 0 && IS_WIN && isAmd && fs.existsSync(bundled) && fs.existsSync(systemLoader)) {
      warn('La GPU AMD non viene usata: applico la correzione nota per Ollama + Vulkan (ollama/ollama#16677)');
      fs.renameSync(bundled, `${bundled}.bak`);
      await stopAllOllama();
      startOllama(bin, dataDir);
      await waitOllama();
      s = spinner('Ricarico il modello sulla GPU…');
      share = await gpuShare(mainModel, ctx).catch(() => undefined);
      s.stop();
      if (!share) {
        fs.renameSync(`${bundled}.bak`, bundled); // didn't help: put it back
        warn('La correzione non ha funzionato ed è stata annullata');
      } else ok('Correzione applicata (va ripetuta dopo ogni aggiornamento di Ollama: il setup lo fa da solo)');
    }
    if (share === undefined) warn('Non sono riuscito a misurare l’uso della GPU');
    else if (share === 0) warn('Il modello gira su CPU: funzionerà, ma più lentamente. Vedi README → "GPU AMD"');
    else ok(`${share}% del modello in VRAM${share < 100 ? dim(' · il resto in RAM (normale per i modelli MoE grandi)') : ''}`);
    state.gpuCheck = { version, model: mainModel, share: share ?? 0, at: new Date().toISOString() };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  // 7 ─ app
  step('Preparo l’app');
  const lock = path.join(ROOT, 'package-lock.json');
  const installed = path.join(ROOT, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'three')) || mtime(installed) < mtime(lock)) npm(['install', '--no-audit', '--no-fund'], 'Installo le dipendenze…');
  else ok('Dipendenze aggiornate');
  const built = Math.min(mtime(path.join(ROOT, 'web', 'dist', 'index.html')), mtime(path.join(ROOT, 'server', 'dist', 'index.js')));
  const sources = Math.max(newest(path.join(ROOT, 'web', 'src')), newest(path.join(ROOT, 'server', 'src')), mtime(path.join(ROOT, 'web', 'index.html')));
  if (!built || sources > built) npm(['run', 'build'], 'Compilo l’interfaccia e il server…');
  else ok('Build aggiornata');

  if (ARGS.has('--no-launch')) {
    console.log(`\n  ${green('Pronto')} in ${Math.round((Date.now() - t0) / 1000)}s. Avvia con ${bold('npm start')}.\n`);
    return;
  }

  // 8 ─ launch
  step('Avvio il cervello');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BRAIN_PORT: String(PORT) },
  });
  server.stderr.on('data', (d) => process.stderr.write(dim(d.toString())));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(250);
    ready = await brainRunning();
    if (server.exitCode !== null) break;
  }
  if (!ready) {
    fail('Il server non è partito. Esegui "npm start" per vedere l’errore.');
    process.exit(1);
  }
  const url = `http://127.0.0.1:${PORT}`;
  ok(`Pronto in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`\n    ${violet(G.eye)} ${bold(url)}   ${dim('— lascia aperta questa finestra; Ctrl+C per spegnere')}\n`);
  openBrowser(url);
  server.stdout.on('data', (d) => {
    const s = d.toString();
    if (!/AI Brain server|data dir|LLM {2,}/.test(s)) process.stdout.write(dim(s));
  });
  const stop = () => {
    server.kill();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
  process.exit(1);
});
