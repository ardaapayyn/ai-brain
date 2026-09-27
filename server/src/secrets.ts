import fs from 'node:fs';
import path from 'node:path';

/**
 * API keys for cloud providers, stored ONLY on this machine (<dataDir>/secrets.json, outside the
 * project folder and never committed). The API never returns a key back — only whether one is set.
 */
export class SecretStore {
  private file: string;
  private data: Record<string, string> = {};

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'secrets.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(id: string): string | undefined {
    return this.data[id] || undefined;
  }

  set(id: string, key: string | null) {
    if (key) this.data[id] = key;
    else delete this.data[id];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* not supported on this filesystem */
    }
  }

  /** Safe summary for the UI: which providers have a key and its last 4 characters. */
  summary(): Record<string, { set: boolean; last4: string }> {
    return Object.fromEntries(Object.entries(this.data).map(([id, k]) => [id, { set: true, last4: k.slice(-4) }]));
  }
}
