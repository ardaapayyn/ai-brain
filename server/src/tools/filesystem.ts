import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isBinaryPath } from '../workspace/workspace.js';
import { num, str, ToolArgError, truncate, type Tool } from './types.js';

const MAX_READ_BYTES = 2_000_000;

async function readText(abs: string): Promise<string> {
  const st = await fsp.stat(abs).catch(() => undefined);
  if (!st) throw new ToolArgError(`File not found: ${abs}`);
  if (st.isDirectory()) throw new ToolArgError('That path is a directory — use list_dir');
  if (st.size > MAX_READ_BYTES) throw new ToolArgError(`File is ${(st.size / 1e6).toFixed(1)} MB — too large; use search_code or read a line range`);
  if (isBinaryPath(abs)) throw new ToolArgError('Binary file — cannot be read as text');
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new ToolArgError('Binary file — cannot be read as text');
  return buf.toString('utf8');
}

export const listDir: Tool = {
  name: 'list_dir',
  category: 'filesystem',
  description: 'List files and folders in a directory of the project (tree view). Ignores node_modules, build output, engine caches, .gitignored paths.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to project root. Default "."' },
      depth: { type: 'integer', description: 'Tree depth 1-4. Default 2' },
    },
  },
  risk: 'none',
  summarize: (a) => `list ${a.path || '.'}`,
  async execute(a, ctx) {
    const ws = ctx.workspace;
    const root = ws.resolve(a.path);
    const depth = Math.min(num(a, 'depth', 2), 4);
    const lines: string[] = [];
    let count = 0;
    const walk = async (dir: string, d: number, indent: string) => {
      if (count > 400) return;
      let entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
      entries = entries
        .filter((e) => !ws.isIgnored(ws.rel(path.join(dir, e.name)), e.isDirectory()))
        .sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of entries) {
        if (++count > 400) {
          lines.push(`${indent}… (truncated)`);
          return;
        }
        if (e.isDirectory()) {
          lines.push(`${indent}${e.name}/`);
          if (d < depth) await walk(path.join(dir, e.name), d + 1, indent + '  ');
        } else {
          lines.push(`${indent}${e.name}`);
        }
      }
    };
    await walk(root, 1, '');
    return { ok: true, output: `${ws.rel(root)}/\n${lines.join('\n') || '(empty)'}` };
  },
};

export const readFile: Tool = {
  name: 'read_file',
  category: 'filesystem',
  description: 'Read a text file with line numbers. For big files pass start_line/end_line to read a window.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      start_line: { type: 'integer', description: '1-based first line (optional)' },
      end_line: { type: 'integer', description: '1-based last line, inclusive (optional)' },
    },
    required: ['path'],
  },
  risk: 'none',
  summarize: (a) => `read ${a.path}${a.start_line ? `:${a.start_line}-${a.end_line ?? ''}` : ''}`,
  async execute(a, ctx) {
    const abs = ctx.workspace.resolve(str(a, 'path'));
    const text = await readText(abs);
    const all = text.split('\n');
    const start = Math.max(1, num(a, 'start_line', 1));
    const maxLines = 800;
    const end = Math.min(all.length, num(a, 'end_line', start + maxLines - 1));
    const width = String(end).length;
    const body = all
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(width)}│${l.replace(/\r$/, '')}`)
      .join('\n');
    const more = end < all.length ? `\n… file continues (${all.length} lines total). Use start_line=${end + 1} to read more.` : '';
    return { ok: true, output: truncate(body, ctx.config.agent.maxToolOutputChars) + more };
  },
};

export const writeFile: Tool = {
  name: 'write_file',
  category: 'filesystem',
  description: 'Create a new file or fully overwrite an existing one. Prefer edit_file for small changes to existing files. Parent folders are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      content: { type: 'string', description: 'Complete file content' },
    },
    required: ['path', 'content'],
  },
  risk: 'fileWrite',
  summarize: (a) => `write ${a.path}`,
  approvalDetail: (a) => `${a.path}\n\n${truncate(String(a.content ?? ''), 3000)}`,
  async execute(a, ctx) {
    const abs = ctx.workspace.resolve(str(a, 'path'));
    const content = typeof a.content === 'string' ? a.content : str(a, 'content');
    const existed = fs.existsSync(abs);
    ctx.checkpoint.snapshot(abs);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    ctx.invalidateIndex();
    return { ok: true, output: `${existed ? 'Overwrote' : 'Created'} ${ctx.workspace.rel(abs)} (${content.split('\n').length} lines)` };
  },
};

/** Locate `needle` in `hay`; falls back to a line-wise whitespace-insensitive match (local models often mangle indentation). */
export function locate(hay: string, needle: string): { index: number; length: number; count: number } | undefined {
  let count = 0;
  let first = -1;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + Math.max(1, needle.length))) {
    if (first < 0) first = i;
    count++;
  }
  if (count) return { index: first, length: needle.length, count };

  const hayLines = hay.split('\n');
  const needleLines = needle.replace(/\n+$/, '').split('\n').map((l) => l.trim());
  if (!needleLines.length || !needleLines.some(Boolean)) return undefined;
  const offsets: number[] = [];
  let off = 0;
  for (const l of hayLines) {
    offsets.push(off);
    off += l.length + 1;
  }
  let match: { index: number; length: number } | undefined;
  count = 0;
  for (let i = 0; i + needleLines.length <= hayLines.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (hayLines[i + j].trim() !== needleLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      count++;
      if (!match) {
        const endLine = i + needleLines.length - 1;
        match = { index: offsets[i], length: offsets[endLine] + hayLines[endLine].length - offsets[i] };
      }
    }
  }
  return match ? { ...match, count } : undefined;
}

export const editFile: Tool = {
  name: 'edit_file',
  category: 'filesystem',
  description:
    'Replace an exact snippet in a file. old_text must match the current file content (copy it from read_file without the line-number prefix) and be unique unless replace_all=true. Include enough surrounding lines to make it unique.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      old_text: { type: 'string', description: 'Exact existing text to replace' },
      new_text: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  risk: 'fileWrite',
  summarize: (a) => `edit ${a.path}`,
  approvalDetail: (a) => `${a.path}\n\n--- before\n${truncate(String(a.old_text ?? ''), 1500)}\n+++ after\n${truncate(String(a.new_text ?? ''), 1500)}`,
  async execute(a, ctx) {
    const abs = ctx.workspace.resolve(str(a, 'path'));
    const original = await readText(abs);
    const crlf = original.includes('\r\n');
    const text = crlf ? original.replace(/\r\n/g, '\n') : original;
    const oldText = String(a.old_text ?? '').replace(/\r\n/g, '\n');
    const newText = String(a.new_text ?? '').replace(/\r\n/g, '\n');
    if (!oldText) throw new ToolArgError('old_text is empty — use write_file to create files');
    const hit = locate(text, oldText);
    if (!hit) throw new ToolArgError('old_text not found in file. Re-read the file (read_file) and copy the exact current text.');
    if (hit.count > 1 && !a.replace_all) throw new ToolArgError(`old_text matches ${hit.count} places — add more surrounding context or set replace_all=true`);

    let updated: string;
    if (a.replace_all && text.includes(oldText)) updated = text.split(oldText).join(newText);
    else updated = text.slice(0, hit.index) + newText + text.slice(hit.index + hit.length);

    ctx.checkpoint.snapshot(abs);
    await fsp.writeFile(abs, crlf ? updated.replace(/\n/g, '\r\n') : updated, 'utf8');
    ctx.invalidateIndex();
    const line = text.slice(0, hit.index).split('\n').length;
    const replaced = a.replace_all ? hit.count : 1;
    return { ok: true, output: `Edited ${ctx.workspace.rel(abs)} at line ${line} (${replaced} replacement${replaced > 1 ? 's' : ''}).` };
  },
};

export const deleteFile: Tool = {
  name: 'delete_file',
  category: 'filesystem',
  description: 'Delete a single file (not directories). Requires user approval.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path relative to project root' } },
    required: ['path'],
  },
  risk: 'fileDelete',
  isDangerous: () => true,
  summarize: (a) => `delete ${a.path}`,
  async execute(a, ctx) {
    const abs = ctx.workspace.resolve(str(a, 'path'));
    const st = await fsp.stat(abs).catch(() => undefined);
    if (!st) throw new ToolArgError('File not found');
    if (!st.isFile()) throw new ToolArgError('Only single files can be deleted');
    ctx.checkpoint.snapshot(abs);
    await fsp.rm(abs);
    ctx.invalidateIndex();
    return { ok: true, output: `Deleted ${ctx.workspace.rel(abs)} (recoverable via Revert run)` };
  },
};

export const filesystemTools = [listDir, readFile, writeFile, editFile, deleteFile];
