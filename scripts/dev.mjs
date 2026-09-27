#!/usr/bin/env node
// Runs the API server (auto-reload) and the Vite UI together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const procs = [];

function run(name, args, color) {
  const p = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin, detached: !isWin, env: { ...process.env, FORCE_COLOR: '1' } });
  const tag = `\x1b[${color}m${name.padEnd(6)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${tag}exited (${code})`);
    shutdown();
  });
  procs.push(p);
  return p;
}

let opened = false;
function openBrowser(url) {
  if (opened || process.env.BRAIN_NO_OPEN) return;
  opened = true;
  const cmd = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Apri il browser su ${url}`));
    child.unref();
  } catch {
    /* no browser available */
  }
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  // Kill whole process trees (npm → tsx/vite), not just the npm wrappers.
  for (const p of procs) {
    try {
      if (isWin) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('server', ['run', 'dev', '-w', 'server'], '35');
const web = run('web', ['run', 'dev', '-w', 'web'], '36');
web.stdout.on('data', (d) => {
  if (/ready in|Local:/.test(d.toString())) setTimeout(() => openBrowser('http://127.0.0.1:5173'), 600);
});
