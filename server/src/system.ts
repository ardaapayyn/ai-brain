import { execFile } from 'node:child_process';
import os from 'node:os';

export interface GpuInfo {
  name: string;
  vramGB?: number;
  vendor: 'amd' | 'nvidia' | 'intel' | 'apple' | 'other';
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  cpu: string;
  cores: number;
  ramGB: number;
  gpus: GpuInfo[];
  recommendation: ModelRecommendation;
}

export interface ModelRecommendation {
  main: string;
  fast?: string;
  contextTokens: number;
  reason: string;
}

const run = (file: string, args: string[], timeout = 8000) =>
  new Promise<string>((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1_000_000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });

const vendorOf = (name: string): GpuInfo['vendor'] =>
  /amd|radeon/i.test(name) ? 'amd' : /nvidia|geforce|rtx|gtx|quadro/i.test(name) ? 'nvidia' : /intel|arc|iris|uhd/i.test(name) ? 'intel' : /apple/i.test(name) ? 'apple' : 'other';

/** Best-effort GPU detection (name + dedicated VRAM) without native deps. */
export async function detectGpus(): Promise<GpuInfo[]> {
  if (process.platform === 'win32') {
    // Win32_VideoController.AdapterRAM is capped at 4 GB — the driver registry key has the real size.
    const ps = `$ErrorActionPreference='SilentlyContinue';
      $r = Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' |
        Where-Object { $_.DriverDesc } | ForEach-Object { [pscustomobject]@{ name = $_.DriverDesc; vram = [long]($_.'HardwareInformation.qwMemorySize') } };
      if (-not $r) { $r = Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = $_.Name; vram = [long]$_.AdapterRAM } } };
      $r | ConvertTo-Json -Compress`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    try {
      const data = JSON.parse(out);
      const list: any[] = Array.isArray(data) ? data : [data];
      const seen = new Set<string>();
      return list
        .filter((g) => g?.name && !/basic display|remote|virtual|parsec|dameware/i.test(g.name) && !seen.has(g.name) && seen.add(g.name))
        .map((g) => ({ name: g.name, vramGB: g.vram > 0 ? Math.round((g.vram / 2 ** 30) * 10) / 10 : undefined, vendor: vendorOf(g.name) }));
    } catch {
      return [];
    }
  }
  if (process.platform === 'darwin') {
    const out = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
    return /apple/i.test(out) ? [{ name: out.trim(), vendor: 'apple', vramGB: Math.round(os.totalmem() / 2 ** 30) }] : [];
  }
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (nv.trim()) {
    return nv
      .trim()
      .split('\n')
      .map((l) => {
        const [name, mem] = l.split(',').map((s) => s.trim());
        return { name, vramGB: Math.round((Number(mem) / 1024) * 10) / 10, vendor: 'nvidia' as const };
      });
  }
  const lspci = await run('lspci', []);
  return lspci
    .split('\n')
    .filter((l) => /VGA|3D controller|Display/.test(l))
    .map((l) => {
      const name = l.replace(/^.*?: /, '');
      return { name, vendor: vendorOf(name) };
    });
}

/**
 * Pick models for the machine. MoE coder models run well with part of the weights in system RAM,
 * so RAM matters as much as VRAM. Keep in sync with scripts/setup.mjs.
 */
export function recommend(ramGB: number, vramGB: number): ModelRecommendation {
  if (ramGB >= 48) return { main: 'qwen3-coder:30b', fast: vramGB >= 6 ? 'qwen3:8b' : 'qwen3:4b', contextTokens: 32768, reason: `${ramGB} GB RAM: coder MoE 30B con offload GPU+RAM` };
  if (ramGB >= 30) return { main: 'qwen3-coder:30b', fast: vramGB >= 6 ? 'qwen3:8b' : 'qwen3:4b', contextTokens: 16384, reason: `${ramGB} GB RAM: coder MoE 30B, contesto ridotto` };
  if (ramGB >= 22 || vramGB >= 12) return { main: 'qwen3:14b', fast: 'qwen3:4b', contextTokens: 16384, reason: 'RAM media: modello denso 14B' };
  if (ramGB >= 12 || vramGB >= 6) return { main: 'qwen3:8b', fast: 'qwen3:4b', contextTokens: 12288, reason: 'RAM limitata: modello 8B' };
  return { main: 'qwen3:4b', contextTokens: 8192, reason: 'Hardware leggero: modello 4B' };
}

let cached: Promise<SystemInfo> | undefined;

export function systemInfo(): Promise<SystemInfo> {
  cached ??= (async () => {
    const gpus = await detectGpus().catch(() => []);
    const ramGB = Math.round(os.totalmem() / 2 ** 30);
    const vram = Math.max(0, ...gpus.map((g) => (g.vendor === 'apple' ? 0 : g.vramGB ?? 0)));
    return {
      platform: process.platform,
      cpu: os.cpus()[0]?.model?.trim() ?? 'CPU',
      cores: os.cpus().length,
      ramGB,
      gpus,
      recommendation: recommend(ramGB, vram),
    };
  })();
  return cached;
}
