import fs from 'node:fs';
import path from 'node:path';

interface Manifest {
  root: string;
  files: Record<string, { existed: boolean; backup?: string }>;
}

/**
 * Per-run snapshot of every file the agent touches, taken *before* the first change.
 * Makes all agent file edits undoable ("Revert run" in the UI) even without git.
 */
export class Checkpoint {
  private dir: string;
  private manifest: Manifest;

  constructor(dataDir: string, readonly runId: string, root: string) {
    this.dir = path.join(dataDir, 'checkpoints', runId);
    const mf = path.join(this.dir, 'manifest.json');
    this.manifest = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : { root, files: {} };
  }

  /** Call before modifying/deleting `abs`. Idempotent per file per run. */
  snapshot(abs: string) {
    const rel = path.relative(this.manifest.root, abs);
    if (this.manifest.files[rel]) return;
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const backup = `f${Object.keys(this.manifest.files).length}`;
      fs.copyFileSync(abs, path.join(this.dir, backup));
      this.manifest.files[rel] = { existed: true, backup };
    } else {
      this.manifest.files[rel] = { existed: false };
    }
    fs.writeFileSync(path.join(this.dir, 'manifest.json'), JSON.stringify(this.manifest, null, 2));
  }

  get touched(): string[] {
    return Object.keys(this.manifest.files).map((f) => f.split(path.sep).join('/'));
  }

  /** Restore every snapshotted file to its pre-run state. Returns restored relative paths. */
  static revert(dataDir: string, runId: string): string[] {
    const dir = path.join(dataDir, 'checkpoints', runId);
    const mf = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mf)) return [];
    const manifest: Manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const restored: string[] = [];
    for (const [rel, info] of Object.entries(manifest.files)) {
      const abs = path.join(manifest.root, rel);
      if (info.existed && info.backup) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(path.join(dir, info.backup), abs);
      } else if (fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true });
      }
      restored.push(rel);
    }
    return restored;
  }
}
