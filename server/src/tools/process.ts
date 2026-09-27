import { spawn, spawnSync } from 'node:child_process';

export interface ProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  windowsShell?: 'default' | 'powershell';
  maxBuffer?: number;
}

function killTree(pid: number) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Run a shell command with timeout, cancellation, live output streaming and output capping. */
export function runCommand(command: string, opts: RunOptions): Promise<ProcessResult> {
  const start = Date.now();
  const max = opts.maxBuffer ?? 400_000;
  const isWin = process.platform === 'win32';
  const [file, args] =
    isWin && opts.windowsShell === 'powershell'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
      : isWin
        ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]]
        : ['/bin/sh', ['-c', command]];

  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1', GIT_TERMINAL_PROMPT: '0' };
  delete env.NODE_TEST_CONTEXT; // never leak the brain's own runtime context into project commands
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env,
      detached: !isWin,
      windowsHide: true,
      windowsVerbatimArguments: isWin && opts.windowsShell !== 'powershell',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let cancelled = false;
    const onData = (d: Buffer) => {
      // eslint-disable-next-line no-control-regex
      const s = d.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      if (output.length < max) output += s;
      opts.onOutput?.(s);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      if (child.pid) killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output, timedOut, cancelled, durationMs: Date.now() - start });
    };
    child.on('error', (err) => {
      output += `\n[spawn error] ${err.message}`;
      done(-1);
    });
    child.on('close', (code) => done(code));
  });
}

const CHAINING = /[;&|`<>]|\$\(/;

const SAFE: RegExp[] = [
  /^git\s+(status|diff|log|show|rev-parse|ls-files|blame|branch(\s+(-a|-r|--list|--show-current))?)(\s|$)/,
  /^(ls|dir|pwd|echo|cat|type|head|tail|wc|tree|where|which|whoami)(\s|$)/,
  /^(node|npm|npx|pnpm|yarn|python3?|py|pip|cargo|go|dotnet|java|javac|gcc|g\+\+|clang|cmake|rustc|tsc|deno|bun)\s+(-v|--version|version)$/,
  /^(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|build|typecheck|check|type-check)(:[\w-]+)?|ls|list|outdated)(\s|$)/,
  /^npx\s+(tsc|vitest\s+run|jest|eslint|prettier\s+--check)(\s|$)/,
  /^(python3?|py)\s+-m\s+(pytest|unittest|mypy|ruff|flake8|py_compile|compileall)(\s|$)/,
  /^(pytest|mypy|ruff\s+check|tsc)(\s|$)/,
  /^cargo\s+(test|build|check|clippy|fmt\s+--check)(\s|$)/,
  /^go\s+(test|build|vet)(\s|$)/,
  /^dotnet\s+(test|build)(\s|$)/,
  /^make(\s+(test|build|check))?$/,
];

const DANGEROUS: RegExp[] = [
  /\brm\s+(-\w*[rf]\w*\s+)+/i,
  /\brm\s+.*\*/,
  /\b(del|erase)\s+.*\/[sq]/i,
  /\b(rd|rmdir)\s+.*\/s/i,
  /Remove-Item\b.*-Recurse/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(mkfs|diskpart|fdisk)\b/i,
  /\bdd\s+if=/,
  /\b(shutdown|reboot|halt|Stop-Computer|Restart-Computer)\b/i,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-\w*f/,
  /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+(rebase|filter-branch)\b/,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(ba|z)?sh\b/i,
  /\b(iex|Invoke-Expression)\b/i,
  /\breg\s+(delete|add)\b/i,
  /\b(chmod|chown)\s+-R\b/,
  /\b(npm|pnpm|yarn|cargo|dotnet\s+nuget)\s+publish\b/,
  /\bsudo\b/,
  /\bkill(all)?\b|\btaskkill\b/i,
  /:\(\)\s*\{/,
];

export function classifyCommand(cmd: string): { risky: boolean; dangerous: boolean } {
  const c = cmd.trim();
  const dangerous = DANGEROUS.some((re) => re.test(c));
  const safe = !dangerous && !CHAINING.test(c) && SAFE.some((re) => re.test(c));
  return { risky: !safe, dangerous };
}

export function formatResult(r: ProcessResult, maxChars: number): string {
  const status = r.cancelled ? 'CANCELLED' : r.timedOut ? 'TIMED OUT' : `exit code ${r.code}`;
  let out = r.output.trim();
  if (out.length > maxChars) {
    // Errors usually live at the end of the output: keep more tail than head.
    const head = Math.floor(maxChars * 0.3);
    out = `${out.slice(0, head)}\n… [${out.length - maxChars} chars truncated] …\n${out.slice(-(maxChars - head))}`;
  }
  return `[${status} · ${(r.durationMs / 1000).toFixed(1)}s]\n${out || '(no output)'}`;
}
