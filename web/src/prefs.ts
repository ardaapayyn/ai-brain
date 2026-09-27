/** Per-browser UI preferences (localStorage, failure-tolerant). */
export type Quality = 'high' | 'medium' | 'low';

export interface Prefs {
  theme: 'dark' | 'light';
  quality: Quality;
  reducedMotion: boolean;
  autoRotate: boolean;
  intro: boolean;
  hiddenTypes: string[];
  mode: 'auto' | 'fast' | 'deep';
  /** Render at ~30 fps while the agent works so the GPU stays free for the model. */
  gpuSaver: boolean;
}

const KEY = 'brain.prefs.v2';

function load(): Prefs {
  const systemReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const defaults: Prefs = {
    theme: 'dark',
    quality: navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4 ? 'medium' : 'high',
    reducedMotion: systemReduced,
    autoRotate: !systemReduced,
    intro: true,
    hiddenTypes: [],
    mode: 'auto',
    gpuSaver: true,
  };
  try {
    const legacyTheme = localStorage.getItem('brain.theme');
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...defaults, ...(legacyTheme === 'light' || legacyTheme === 'dark' ? { theme: legacyTheme } : {}), ...saved };
  } catch {
    return defaults;
  }
}

export const prefs: Prefs = load();

export function savePrefs(patch: Partial<Prefs>) {
  Object.assign(prefs, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode) */
  }
}

export const QUALITY: Record<Quality, { neurons: number; pixelRatio: number; bloom: number; dust: number; post: boolean }> = {
  high: { neurons: 14000, pixelRatio: 2, bloom: 1, dust: 2600, post: true },
  medium: { neurons: 9000, pixelRatio: 1.25, bloom: 0.85, dust: 1500, post: true },
  low: { neurons: 5000, pixelRatio: 1, bloom: 0.6, dust: 600, post: false },
};
