import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_IGNORES } from './workspace.js';

export interface FolderInfo {
  path: string;
  name: string;
  /** Detected project type (Unity, Node.js, …) when the folder looks like a project root. */
  kind?: string;
}

/** Markers that identify a project root, most specific first. */
const MARKERS: [test: (entries: Set<string>, names: string[]) => boolean, kind: string][] = [
  [(e) => e.has('Assets') && e.has('ProjectSettings'), 'Unity'],
  [(_, n) => n.some((x) => x.endsWith('.uproject')), 'Unreal'],
  [(e) => e.has('project.godot'), 'Godot'],
  [(e) => e.has('Cargo.toml'), 'Rust'],
  [(e) => e.has('go.mod'), 'Go'],
  [(_, n) => n.some((x) => x.endsWith('.sln') || x.endsWith('.csproj')), '.NET'],
  [(e) => e.has('pubspec.yaml'), 'Flutter'],
  [(e) => e.has('package.json'), 'Node.js'],
  [(e) => e.has('pyproject.toml') || e.has('requirements.txt') || e.has('setup.py'), 'Python'],
  [(e) => e.has('pom.xml') || e.has('build.gradle') || e.has('build.gradle.kts'), 'Java/Kotlin'],
  [(e) => e.has('CMakeLists.txt'), 'C/C++'],
  [(e) => e.has('composer.json'), 'PHP'],
  [(e) => e.has('Gemfile'), 'Ruby'],
  [(e) => e.has('.git'), 'Git'],
];

const SKIP = new Set([
  ...DEFAULT_IGNORES,
  'AppData', 'Application Data', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Windows', '$Recycle.Bin',
  'System Volume Information', 'Recovery', 'PerfLogs', 'Music', 'Pictures', 'Videos', 'Movies', 'Library', 'Applications',
  'OneDriveTemp', 'Saved Games', 'Contacts', 'Favorites', 'Links', 'Searches', '3D Objects', 'Steam', 'SteamLibrary',
  'Epic Games', 'snap', 'proc', 'sys', 'dev', 'usr', 'bin', 'sbin', 'etc', 'var', 'boot', 'lib', 'lib64', 'opt', 'tmp', 'run',
]);

export async function projectKind(dir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return undefined;
  }
  const set = new Set(names);
  for (const [test, kind] of MARKERS) if (test(set, names)) return kind;
  return undefined;
}

/** Filesystem roots: drive letters on Windows, "/" elsewhere (plus the home folder). */
export function fsRoots(): FolderInfo[] {
  const home = os.homedir();
  const roots: FolderInfo[] = [{ path: home, name: 'Home' }];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try {
        if (fs.existsSync(d)) roots.push({ path: d, name: `Disco ${d.slice(0, 2)}` });
      } catch {
        /* drive not ready */
      }
    }
  } else roots.push({ path: '/', name: 'Radice' });
  return roots;
}

/** List sub-folders of `dir`, flagging the ones that look like projects. */
export async function browse(dir: string): Promise<{ path: string; parent?: string; folders: FolderInfo[] }> {
  const abs = path.resolve(dir);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !SKIP.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .slice(0, 400);
  const folders = await Promise.all(dirs.map(async (name) => ({ path: path.join(abs, name), name, kind: await projectKind(path.join(abs, name)) })));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent !== abs ? parent : undefined, folders };
}

/** Places where people usually keep code/game projects. */
function candidateRoots(): string[] {
  const home = os.homedir();
  const docs = [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'OneDrive', 'Documenti'), path.join(home, 'Documenti')];
  const list = [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    ...docs,
    ...docs.flatMap((d) => [path.join(d, 'GitHub'), path.join(d, 'Unity Projects'), path.join(d, 'Unreal Projects'), path.join(d, 'Visual Studio 2022', 'Projects'), path.join(d, 'Godot')]),
    path.join(home, 'source', 'repos'),
    ...['Projects', 'projects', 'Progetti', 'dev', 'Dev', 'code', 'Code', 'git', 'repos', 'workspace', 'src', 'GitHub', 'Unity', 'UnityProjects', 'Games', 'GameDev'].map((n) => path.join(home, n)),
  ];
  if (process.platform === 'win32') {
    for (const r of fsRoots().slice(1)) list.push(r.path, ...['Projects', 'Progetti', 'dev', 'code', 'repos', 'Unity', 'GameDev', 'Games'].map((n) => path.join(r.path, n)));
  }
  return [...new Set(list)].filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Find project folders in the usual places (breadth-first, bounded in depth, count and time).
 * Stops descending once a project root is found.
 */
export async function discoverProjects(opts: { maxDepth?: number; limit?: number; budgetMs?: number } = {}): Promise<{ projects: FolderInfo[]; scanned: number; ms: number }> {
  const t0 = Date.now();
  const maxDepth = opts.maxDepth ?? 3;
  const limit = opts.limit ?? 200;
  const budget = opts.budgetMs ?? 4000;
  const found = new Map<string, FolderInfo>();
  const seen = new Set<string>();
  const home = path.resolve(os.homedir());
  let scanned = 0;
  const queue: [string, number][] = candidateRoots().map((r) => [r, 0]);

  while (queue.length && found.size < limit && Date.now() - t0 < budget) {
    const [dir, depth] = queue.shift()!;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    scanned++;
    // never report the home folder or drive roots themselves as a project
    const isRootish = path.resolve(dir) === home || path.dirname(dir) === dir;
    const kind = isRootish ? undefined : await projectKind(dir);
    if (kind) {
      found.set(key, { path: dir, name: path.basename(dir), kind });
      continue;
    }
    if (depth >= maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$') || SKIP.has(e.name)) continue;
      queue.push([path.join(dir, e.name), depth + 1]);
    }
  }
  const projects = [...found.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { projects, scanned, ms: Date.now() - t0 };
}
