import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Directories never worth walking (VCS, deps, build output, engine caches for Unity/Unreal/Godot). */
export const DEFAULT_IGNORES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.tox', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.next', '.nuxt', '.cache',
  '.turbo', '.parcel-cache', 'coverage', '.idea', '.vs', '.gradle', 'Library', 'Temp', 'Logs',
  'Intermediate', 'Binaries', 'Saved', 'DerivedDataCache', '.godot', '.import', 'Pods',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.psd', '.tga', '.exr', '.hdr', '.dds', '.ktx',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mov', '.avi', '.webm', '.zip', '.7z', '.rar', '.gz', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.pdb', '.lib', '.a', '.o', '.obj', '.class', '.jar', '.pdf', '.fbx',
  '.blend', '.glb', '.gltf', '.uasset', '.umap', '.pak', '.woff', '.woff2', '.ttf', '.otf', '.bin', '.dat',
  '.db', '.sqlite', '.wasm', '.pyc', '.asset', '.unity3d', '.bank',
]);

export const isBinaryPath = (p: string) => BINARY_EXT.has(path.extname(p).toLowerCase());

export class SandboxError extends Error {}

/**
 * A project root the agent is confined to. Every path coming from the model goes through
 * `resolve()`, which rejects anything escaping the root (.., absolute paths elsewhere, symlinks out).
 */
export class Workspace {
  readonly root: string;
  private gitignore: RegExp[] = [];

  constructor(root: string) {
    this.root = fs.realpathSync(path.resolve(root));
    this.loadGitignore();
  }

  resolve(p: unknown): string {
    const input = String(p ?? '.').trim() || '.';
    const abs = path.resolve(this.root, input);
    if (!this.contains(abs)) throw new SandboxError(`Path "${input}" is outside the project root`);
    // Resolve symlinks on the deepest existing ancestor so links can't escape the root.
    let probe = abs;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (!this.contains(real)) throw new SandboxError(`Path "${input}" resolves outside the project root`);
    return abs;
  }

  private contains(abs: string): boolean {
    const rel = path.relative(this.root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/') || '.';
  }

  private loadGitignore() {
    try {
      const txt = fs.readFileSync(path.join(this.root, '.gitignore'), 'utf8');
      this.gitignore = txt
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
        .map(globToRegExp);
    } catch {
      this.gitignore = [];
    }
  }

  isIgnored(relPath: string, isDir: boolean): boolean {
    const base = relPath.split('/').pop()!;
    if (isDir && DEFAULT_IGNORES.has(base)) return true;
    const candidate = isDir ? relPath + '/' : relPath;
    return this.gitignore.some((re) => re.test(candidate));
  }

  /** Walk files (relative posix paths), honoring ignores. */
  async walk(opts: { dir?: string; maxFiles?: number; includeBinary?: boolean } = {}): Promise<string[]> {
    const out: string[] = [];
    const max = opts.maxFiles ?? 20000;
    const start = this.resolve(opts.dir ?? '.');
    const stack = [start];
    while (stack.length && out.length < max) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = this.rel(abs);
        if (e.isDirectory()) {
          if (!this.isIgnored(rel, true)) stack.push(abs);
        } else if (e.isFile()) {
          if (this.isIgnored(rel, false)) continue;
          if (!opts.includeBinary && isBinaryPath(rel)) continue;
          out.push(rel);
          if (out.length >= max) break;
        }
      }
    }
    return out.sort();
  }
}

/** Minimal .gitignore glob → RegExp (supports *, **, ?, leading /, trailing /). */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/');
  const anchored = g.startsWith('/') || g.slice(0, -1).includes('/');
  g = g.replace(/^\//, '');
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored ? '^' : '(^|.*/)';
  const suffix = dirOnly ? '/' : '(/|$)';
  return new RegExp(prefix + re + suffix);
}

/** Simple glob for find_files: matches against the relative posix path (or basename if no slash). */
export function matchGlob(pattern: string, relPath: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > i) {
        re += '(' + p.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const target = p.includes('/') ? relPath : relPath.split('/').pop()!;
  return new RegExp('^' + re + '$', 'i').test(target);
}
