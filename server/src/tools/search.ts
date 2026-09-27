import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import { findSymbol, renderOverview } from '../workspace/indexer.js';
import { DEFAULT_IGNORES, matchGlob } from '../workspace/workspace.js';
import { num, str, truncate, type Tool, type ToolContext } from './types.js';

let rgAvailable: boolean | undefined;
function hasRipgrep() {
  if (rgAvailable === undefined) {
    try {
      rgAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

const MAX_HITS = 150;

function ripgrep(ctx: ToolContext, query: string, regex: boolean, glob: string | undefined, caseSensitive: boolean): Promise<string[]> {
  const args = ['-n', '--no-heading', '--color', 'never', '--max-columns', '240', '--max-columns-preview', '--no-require-git', '-m', '20'];
  args.push(caseSensitive ? '-s' : '-i');
  if (!regex) args.push('-F');
  for (const d of DEFAULT_IGNORES) args.push('-g', `!${d}/`);
  if (glob) args.push('-g', glob);
  args.push('-e', query, '--', '.');
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd: ctx.workspace.root, windowsHide: true, signal: ctx.signal });
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0 && lines.length < MAX_HITS) {
        lines.push(buf.slice(0, nl).replace(/^\.[\\/]/, '').replace(/\\/g, '/'));
        buf = buf.slice(nl + 1);
      }
      if (lines.length >= MAX_HITS) child.kill();
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 2 && !lines.length) reject(new Error(err.trim() || 'ripgrep failed'));
      else resolve(lines);
    });
  });
}

async function jsGrep(ctx: ToolContext, query: string, regex: boolean, glob: string | undefined, caseSensitive: boolean): Promise<string[]> {
  const re = regex ? new RegExp(query, caseSensitive ? '' : 'i') : undefined;
  const q = caseSensitive ? query : query.toLowerCase();
  const out: string[] = [];
  for (const rel of await ctx.workspace.walk()) {
    if (glob && !matchGlob(glob, rel)) continue;
    let text: string;
    try {
      const abs = ctx.workspace.resolve(rel);
      if ((await fsp.stat(abs)).size > 1_000_000) continue;
      text = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const hit = re ? re.test(l) : (caseSensitive ? l : l.toLowerCase()).includes(q);
      if (hit) {
        out.push(`${rel}:${i + 1}:${l.slice(0, 240).replace(/\r$/, '')}`);
        if (out.length >= MAX_HITS) return out;
      }
    }
  }
  return out;
}

export const searchCode: Tool = {
  name: 'search_code',
  category: 'search',
  description: 'Search file contents across the project (like grep/ripgrep). Returns path:line:text. Use it to find where things are defined/used.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regex to search for' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.cs" or "src/**/*.ts"' },
      case_sensitive: { type: 'boolean', description: 'Default false' },
    },
    required: ['query'],
  },
  risk: 'none',
  summarize: (a) => `search "${a.query}"${a.glob ? ` in ${a.glob}` : ''}`,
  async execute(a, ctx) {
    const query = str(a, 'query');
    const regex = !!a.regex;
    if (regex) new RegExp(query); // validate early for a clear error
    const glob = a.glob ? String(a.glob) : undefined;
    const cs = !!a.case_sensitive;
    const hits = hasRipgrep() ? await ripgrep(ctx, query, regex, glob, cs) : await jsGrep(ctx, query, regex, glob, cs);
    if (!hits.length) return { ok: true, output: 'No matches.' };
    const more = hits.length >= MAX_HITS ? `\n… stopped at ${MAX_HITS} matches — refine the query or glob.` : '';
    return { ok: true, output: truncate(hits.join('\n'), ctx.config.agent.maxToolOutputChars) + more };
  },
};

export const findFiles: Tool = {
  name: 'find_files',
  category: 'search',
  description: 'Find files by name/glob, e.g. "*Combat*.cs", "**/*.test.ts", "package.json".',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'Glob pattern (matched on basename if it has no "/")' } },
    required: ['pattern'],
  },
  risk: 'none',
  summarize: (a) => `find ${a.pattern}`,
  async execute(a, ctx) {
    const pattern = str(a, 'pattern');
    const files = (await ctx.workspace.walk({ includeBinary: true })).filter((f) => matchGlob(pattern, f));
    if (!files.length) return { ok: true, output: 'No files found.' };
    return { ok: true, output: files.slice(0, 300).join('\n') + (files.length > 300 ? `\n… ${files.length - 300} more` : '') };
  },
};

export const projectOverview: Tool = {
  name: 'project_overview',
  category: 'search',
  description: 'Get an indexed overview of the whole codebase: languages, frameworks, test command, key files, and the main source files with their classes/functions. Call this first when starting on a project.',
  parameters: { type: 'object', properties: {} },
  risk: 'none',
  summarize: () => 'index codebase',
  async execute(_a, ctx) {
    const idx = await ctx.getIndex();
    return { ok: true, output: renderOverview(idx, Math.min(8000, ctx.config.agent.maxToolOutputChars)) };
  },
};

export const findSymbolTool: Tool = {
  name: 'find_symbol',
  category: 'search',
  description: 'Find classes/functions/methods by (partial) name using the project index. Returns path:line name.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol name or fragment, e.g. "Combat" or "applyDamage"' },
      limit: { type: 'integer', description: 'Max results (default 40)' },
    },
    required: ['name'],
  },
  risk: 'none',
  summarize: (a) => `symbol ${a.name}`,
  async execute(a, ctx) {
    const hits = findSymbol(await ctx.getIndex(), str(a, 'name'), num(a, 'limit', 40));
    return { ok: true, output: hits.length ? hits.join('\n') : 'No symbols found. Try search_code.' };
  },
};

export const searchTools = [projectOverview, searchCode, findFiles, findSymbolTool];
