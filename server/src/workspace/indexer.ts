import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './workspace.js';

export interface FileEntry {
  path: string;
  lang: string;
  size: number;
  lines: number;
  symbols: string[];
}

export interface ProjectIndex {
  root: string;
  builtAt: number;
  files: FileEntry[];
  languages: Record<string, number>;
  frameworks: string[];
  testCommand?: string;
  keyFiles: string[];
  topDirs: { name: string; files: number }[];
  truncated: boolean;
}

const LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.cs': 'C#', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.h': 'C/C++',
  '.c': 'C', '.gd': 'GDScript', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
  '.lua': 'Lua', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.dart': 'Dart', '.vue': 'Vue',
  '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.json': 'JSON', '.md': 'Markdown',
  '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.xml': 'XML', '.sql': 'SQL', '.sh': 'Shell',
  '.ps1': 'PowerShell', '.shader': 'Shader', '.hlsl': 'Shader', '.glsl': 'Shader', '.gdshader': 'Shader',
  '.tscn': 'Godot Scene', '.uproject': 'Unreal', '.csproj': 'MSBuild', '.sln': 'MSBuild',
};

const CODE_LANGS = new Set(['TypeScript', 'JavaScript', 'Python', 'C#', 'C++', 'C/C++', 'C', 'GDScript', 'Go', 'Rust', 'Java', 'Kotlin', 'Lua', 'Ruby', 'PHP', 'Swift', 'Dart', 'Vue', 'Svelte']);

/** Cheap, language-agnostic-ish symbol extraction: classes, functions, methods, types. */
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  TypeScript: [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/],
  JavaScript: [/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/],
  Python: [/^\s*class\s+(\w+)/, /^\s*(?:async\s+)?def\s+(\w+)/],
  'C#': [/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly)\s+)*(?:class|struct|interface|enum|record)\s+(\w+)/, /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async)\s+)+[\w<>\[\],.?\s]+?\s+(\w+)\s*\([^;]*$/],
  'C++': [/^\s*(?:class|struct|enum(?:\s+class)?)\s+(?:\w+_API\s+)?(\w+)\s*[:{]/, /^[\w:<>*&\s]+?\s+([\w:~]+)\s*\([^;]*\)\s*(?:const)?\s*\{?\s*$/],
  'C/C++': [/^\s*(?:class|struct|enum(?:\s+class)?)\s+(?:\w+_API\s+)?(\w+)\s*[:{]/],
  C: [/^\s*(?:struct|enum)\s+(\w+)\s*\{/, /^[\w*\s]+?\s+(\w+)\s*\([^;]*\)\s*\{?\s*$/],
  GDScript: [/^\s*class_name\s+(\w+)/, /^\s*class\s+(\w+)/, /^\s*(?:static\s+)?func\s+(\w+)/],
  Go: [/^\s*type\s+(\w+)\s+(?:struct|interface)/, /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/],
  Rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+(\w+)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?(\w+)/],
  Java: [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:class|interface|enum|record)\s+(\w+)/, /^\s*(?:(?:public|private|protected|static|final|synchronized)\s+)+[\w<>\[\],\s]+?\s+(\w+)\s*\(/],
  Kotlin: [/^\s*(?:\w+\s+)*(?:class|interface|object)\s+(\w+)/, /^\s*(?:\w+\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/],
  Lua: [/^\s*(?:local\s+)?function\s+([\w.:]+)/],
  Ruby: [/^\s*(?:class|module)\s+([\w:]+)/, /^\s*def\s+([\w.?!]+)/],
  PHP: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/, /^\s*(?:(?:public|private|protected|static)\s+)*function\s+(\w+)/],
  Swift: [/^\s*(?:\w+\s+)*(?:class|struct|enum|protocol|extension)\s+(\w+)/, /^\s*(?:\w+\s+)*func\s+(\w+)/],
  Dart: [/^\s*(?:abstract\s+)?class\s+(\w+)/],
};

const KEY_FILES = [
  'README.md', 'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Makefile', 'project.godot',
  'ProjectSettings/ProjectVersion.txt', 'Dockerfile', 'docker-compose.yml', 'vite.config.ts', '.env.example',
];

const MAX_FILE_BYTES = 400_000;

export async function buildIndex(ws: Workspace): Promise<ProjectIndex> {
  const LIMIT = 15000;
  const paths = await ws.walk({ maxFiles: LIMIT });
  const files: FileEntry[] = [];
  const languages: Record<string, number> = {};
  const dirCounts = new Map<string, number>();

  for (const rel of paths) {
    const ext = path.extname(rel).toLowerCase();
    const lang = LANG[ext] ?? (rel.endsWith('.uproject') ? 'Unreal' : 'Other');
    const top = rel.includes('/') ? rel.split('/')[0] : '.';
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
    let size = 0;
    let lines = 0;
    let symbols: string[] = [];
    try {
      const st = await fsp.stat(ws.resolve(rel));
      size = st.size;
      if (CODE_LANGS.has(lang) && size <= MAX_FILE_BYTES) {
        const text = await fsp.readFile(ws.resolve(rel), 'utf8');
        const all = text.split('\n');
        lines = all.length;
        symbols = extractSymbols(lang, all);
      }
    } catch {
      /* unreadable file: keep entry with zero stats */
    }
    if (lang !== 'Other') languages[lang] = (languages[lang] ?? 0) + 1;
    files.push({ path: rel, lang, size, lines, symbols });
  }

  const has = (p: string) => fs.existsSync(path.join(ws.root, p));
  const frameworks = detectFrameworks(ws, paths, has);
  return {
    root: ws.root,
    builtAt: Date.now(),
    files,
    languages,
    frameworks,
    testCommand: detectTestCommand(ws, has, paths),
    keyFiles: KEY_FILES.filter(has).concat(paths.filter((p) => /\.(sln|uproject)$/.test(p)).slice(0, 5)),
    topDirs: [...dirCounts.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files),
    truncated: paths.length >= LIMIT,
  };
}

export function extractSymbols(lang: string, lines: string[]): string[] {
  const pats = SYMBOL_PATTERNS[lang];
  if (!pats) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'using', 'sizeof']);
  for (let i = 0; i < lines.length && out.length < 60; i++) {
    const line = lines[i];
    if (line.length > 300) continue;
    for (const re of pats) {
      const m = re.exec(line);
      if (m && m[1] && !skip.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(`${m[1]}:${i + 1}`);
        break;
      }
    }
  }
  return out;
}

function readJsonSafe(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function detectFrameworks(ws: Workspace, paths: string[], has: (p: string) => boolean): string[] {
  const f: string[] = [];
  if (has('ProjectSettings/ProjectVersion.txt') || paths.some((p) => p.startsWith('Assets/') && p.endsWith('.cs'))) f.push('Unity');
  if (paths.some((p) => p.endsWith('.uproject'))) f.push('Unreal Engine');
  if (has('project.godot')) f.push('Godot');
  const pkg = readJsonSafe(path.join(ws.root, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, name] of Object.entries({ react: 'React', vue: 'Vue', svelte: 'Svelte', next: 'Next.js', three: 'three.js', express: 'Express', fastify: 'Fastify', vite: 'Vite', electron: 'Electron', phaser: 'Phaser', vitest: 'Vitest', jest: 'Jest' }))
      if (deps[dep]) f.push(name);
    f.push('Node.js');
  }
  if (has('pyproject.toml') || has('requirements.txt')) f.push('Python');
  if (has('Cargo.toml')) f.push('Rust/Cargo');
  if (has('go.mod')) f.push('Go');
  if (paths.some((p) => p.endsWith('.csproj'))) f.push('.NET');
  return [...new Set(f)];
}

export function detectTestCommand(ws: Workspace, has: (p: string) => boolean, paths: string[]): string | undefined {
  const pkg = readJsonSafe(path.join(ws.root, 'package.json'));
  if (pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    return `${pm} test`;
  }
  if (has('pytest.ini') || has('pyproject.toml') || paths.some((p) => /(^|\/)test_[^/]*\.py$/.test(p))) return 'python -m pytest -q';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (paths.some((p) => p.endsWith('.sln') || p.endsWith('.csproj')) && !has('ProjectSettings/ProjectVersion.txt')) return 'dotnet test';
  if (has('Makefile')) return 'make test';
  return undefined;
}

/** Compact, LLM-friendly overview of the codebase. */
export function renderOverview(idx: ProjectIndex, maxChars = 6000): string {
  const langs = Object.entries(idx.languages).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, n]) => `${l} (${n})`).join(', ');
  const parts = [
    `Root: ${idx.root}`,
    `Files indexed: ${idx.files.length}${idx.truncated ? ' (truncated)' : ''}`,
    `Languages: ${langs || 'n/a'}`,
    `Frameworks: ${idx.frameworks.join(', ') || 'none detected'}`,
    `Test command: ${idx.testCommand ?? 'none detected'}`,
    `Key files: ${idx.keyFiles.join(', ') || 'none'}`,
    `Top-level: ${idx.topDirs.slice(0, 15).map((d) => `${d.name} (${d.files})`).join(', ')}`,
    '',
    'Largest source files with symbols (name:line):',
  ];
  const ranked = idx.files.filter((f) => f.symbols.length).sort((a, b) => b.lines - a.lines);
  let out = parts.join('\n');
  for (const f of ranked) {
    const line = `\n- ${f.path} [${f.lines} lines] ${f.symbols.slice(0, 12).join(', ')}`;
    if (out.length + line.length > maxChars) {
      out += `\n… ${ranked.length - ranked.indexOf(f)} more source files`;
      break;
    }
    out += line;
  }
  return out;
}

export function findSymbol(idx: ProjectIndex, query: string, limit = 40): string[] {
  const q = query.toLowerCase();
  const hits: { score: number; text: string }[] = [];
  for (const f of idx.files) {
    for (const s of f.symbols) {
      const [name, line] = s.split(':');
      const n = name.toLowerCase();
      if (!n.includes(q) && !f.path.toLowerCase().includes(q)) continue;
      const score = n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0.5;
      hits.push({ score, text: `${f.path}:${line}  ${name}` });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.text);
}
