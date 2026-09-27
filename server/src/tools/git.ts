import { execFile } from 'node:child_process';
import { num, str, ToolArgError, truncate, type Tool, type ToolContext } from './types.js';

/** Run git with an argv array (no shell → no injection through arguments). */
export function git(ctx: Pick<ToolContext, 'workspace' | 'signal'>, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: ctx.workspace.root, signal: ctx.signal, maxBuffer: 8_000_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err: any, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ code: 127, out: 'git is not installed or not on PATH' });
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: (stdout + (stderr ? `\n${stderr}` : '')).trim() });
      },
    );
  });
}

async function ensureRepo(ctx: ToolContext) {
  const r = await git(ctx, ['rev-parse', '--is-inside-work-tree']);
  if (r.code !== 0) throw new ToolArgError('This project is not a git repository (you can ask the user whether to run `git init`).');
}

const safePath = (p: string) => {
  if (p.startsWith('-')) throw new ToolArgError(`Invalid path "${p}"`);
  return p;
};

export const gitStatus: Tool = {
  name: 'git_status',
  category: 'git',
  description: 'Show git branch and working tree status (changed, staged, untracked files).',
  parameters: { type: 'object', properties: {} },
  risk: 'none',
  summarize: () => 'git status',
  async execute(_a, ctx) {
    await ensureRepo(ctx);
    const r = await git(ctx, ['status', '--short', '--branch']);
    return { ok: r.code === 0, output: r.out || 'Clean working tree.' };
  },
};

export const gitDiff: Tool = {
  name: 'git_diff',
  category: 'git',
  description: 'Show the git diff of uncommitted changes (optionally for one path, or staged changes).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Limit to this file/folder' },
      staged: { type: 'boolean', description: 'Show staged changes instead of unstaged' },
    },
  },
  risk: 'none',
  summarize: (a) => `git diff${a.path ? ` ${a.path}` : ''}`,
  async execute(a, ctx) {
    await ensureRepo(ctx);
    const args = ['diff', '--no-color', '--stat', '--patch'];
    if (a.staged) args.push('--staged');
    if (a.path) args.push('--', safePath(ctx.workspace.rel(ctx.workspace.resolve(String(a.path)))));
    const r = await git(ctx, args);
    return { ok: r.code === 0, output: truncate(r.out || 'No changes.', ctx.config.agent.maxToolOutputChars) };
  },
};

export const gitLog: Tool = {
  name: 'git_log',
  category: 'git',
  description: 'Show recent commits (one line each).',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Number of commits (default 15)' },
      path: { type: 'string', description: 'Only commits touching this path' },
    },
  },
  risk: 'none',
  summarize: () => 'git log',
  async execute(a, ctx) {
    await ensureRepo(ctx);
    const args = ['log', '--no-color', `-n${Math.min(num(a, 'limit', 15), 100)}`, '--pretty=format:%h %ad %an: %s', '--date=short'];
    if (a.path) args.push('--', safePath(ctx.workspace.rel(ctx.workspace.resolve(String(a.path)))));
    const r = await git(ctx, args);
    return { ok: r.code === 0, output: r.out || 'No commits yet.' };
  },
};

export const gitCommit: Tool = {
  name: 'git_commit',
  category: 'git',
  description: 'Stage files and create a commit. Only commit when the user asked for it or clearly expects it. Never pushes.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message' },
      files: { type: 'array', items: { type: 'string' }, description: 'Paths to stage; omit to stage all changes' },
    },
    required: ['message'],
  },
  risk: 'git',
  summarize: (a) => `git commit "${String(a.message ?? '').split('\n')[0]}"`,
  approvalDetail: (a) => `git add ${Array.isArray(a.files) && a.files.length ? a.files.join(' ') : '-A'}\ngit commit -m "${a.message}"`,
  async execute(a, ctx) {
    await ensureRepo(ctx);
    const message = str(a, 'message');
    const files: string[] = Array.isArray(a.files) ? a.files.map((f: unknown) => safePath(ctx.workspace.rel(ctx.workspace.resolve(String(f))))) : [];
    const add = await git(ctx, files.length ? ['add', '--', ...files] : ['add', '-A']);
    if (add.code !== 0) return { ok: false, output: add.out };
    const r = await git(ctx, ['commit', '-m', message]);
    return { ok: r.code === 0, output: r.out };
  },
};

export const gitBranch: Tool = {
  name: 'git_branch',
  category: 'git',
  description: 'Create and switch to a new branch (keeps uncommitted changes). Useful before a large change.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'New branch name' } },
    required: ['name'],
  },
  risk: 'git',
  summarize: (a) => `git switch -c ${a.name}`,
  async execute(a, ctx) {
    await ensureRepo(ctx);
    const name = str(a, 'name');
    if (!/^[\w./-]+$/.test(name) || name.startsWith('-')) throw new ToolArgError('Invalid branch name');
    const r = await git(ctx, ['switch', '-c', name]);
    return { ok: r.code === 0, output: r.out };
  },
};

export const gitTools = [gitStatus, gitDiff, gitLog, gitCommit, gitBranch];
