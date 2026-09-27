import { h } from './dom';
import { icon } from './icons';
import { TYPE_COLOR } from './tooltip';

export interface HudActions {
  palette(): void;
  addProjects(): void;
  toggleTheme(): void;
  settings(): void;
}

/**
 * Minimal top-right controls: icon-only, no chrome. The model status lives as a tiny dot on the
 * settings icon (details on hover); problems surface through the banner instead.
 */
export class HudRight {
  readonly el: HTMLDivElement;
  private themeBtn: HTMLButtonElement;
  private settingsBtn: HTMLButtonElement;
  private dot = h('i', { class: 'hud-dot' });

  constructor(a: HudActions, theme: 'dark' | 'light') {
    const isMac = /Mac/.test(navigator.platform);
    this.themeBtn = h('button', { class: 'hud-btn', 'data-tip': 'Tema  (T)', onclick: a.toggleTheme }) as HTMLButtonElement;
    this.settingsBtn = h('button', { class: 'hud-btn', 'data-tip': 'Impostazioni', onclick: a.settings }, icon('settings', 18), this.dot) as HTMLButtonElement;
    this.setTheme(theme);
    this.el = h(
      'div',
      { class: 'hud-right zen' },
      h('button', { class: 'hud-btn', 'data-tip': `Cerca  (${isMac ? '⌘' : 'Ctrl'} K)`, onclick: a.palette }, icon('search', 18)),
      h('button', { class: 'hud-btn', 'data-tip': 'Aggiungi progetti', onclick: a.addProjects }, icon('folderPlus', 18)),
      this.themeBtn,
      this.settingsBtn,
    );
  }

  setTheme(theme: 'dark' | 'light') {
    this.themeBtn.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon', 18));
  }

  setStatus(s: { connected: boolean; ok: boolean; busy: boolean; model?: string }) {
    const state = !s.connected ? 'bad' : s.busy ? 'busy' : s.ok ? 'ok' : 'bad';
    this.dot.className = `hud-dot ${state}`;
    const label = !s.connected ? 'server offline' : `${s.model ?? '…'} · ${s.busy ? 'al lavoro' : s.ok ? 'pronto' : 'non pronto'}`;
    this.settingsBtn.dataset.tip = `Impostazioni — ${label}`;
  }
}

const LEGEND: { type: string; label: string }[] = [
  { type: 'project', label: 'Progetti' },
  { type: 'module', label: 'Moduli' },
  { type: 'task', label: 'Task' },
  { type: 'memory', label: 'Memorie' },
  { type: 'tool', label: 'Strumenti' },
];

/** Collapsible legend: a single icon until opened; toggles node types on/off. */
export class Legend {
  readonly el = h('div', { class: 'legend zen' });
  private open = false;
  private counts: Record<string, number> = {};

  constructor(private hidden: Set<string>, private onChange: (hidden: Set<string>) => void) {
    this.render(this.counts);
  }

  render(counts: Record<string, number>) {
    this.counts = counts;
    const toggle = h('button', { class: `hud-btn ${this.open ? 'on' : ''}`, 'data-tip': this.open ? 'Chiudi mappa' : 'Mappa e filtri', onclick: () => ((this.open = !this.open), this.render(this.counts)) }, icon('module', 18));
    if (!this.open) return this.el.replaceChildren(toggle);
    this.el.replaceChildren(
      h(
        'div',
        { class: 'legend-card glass' },
        ...LEGEND.map((l) =>
          h(
            'button',
            {
              class: this.hidden.has(l.type) ? 'off' : '',
              onclick: () => {
                this.hidden.has(l.type) ? this.hidden.delete(l.type) : this.hidden.add(l.type);
                this.onChange(this.hidden);
                this.render(this.counts);
              },
            },
            h('i', { style: `--c:${TYPE_COLOR[l.type]}` }),
            l.label,
            h('span', { class: 'n' }, String(counts[l.type] ?? 0)),
          ),
        ),
      ),
      toggle,
    );
  }
}

export class Banner {
  readonly el = h('div', { class: 'banner glass' });
  constructor() {
    this.el.style.display = 'none';
  }
  show(...children: (Node | string)[]) {
    this.el.replaceChildren(icon('alert', 16), ...children);
    this.el.style.display = '';
  }
  hide() {
    this.el.style.display = 'none';
  }
}

export class OfflineOverlay {
  readonly el = h(
    'div',
    { class: 'offline' },
    h(
      'div',
      { class: 'card glass' },
      h('div', { class: 'spinner' }),
      h('h3', null, 'Il nucleo è offline'),
      h('p', null, 'Mi riconnetto automaticamente. Se non torna, avvia AI Brain con ', h('code', null, 'AI-Brain.bat'), '.'),
    ),
  );
  private timer?: number;
  constructor() {
    this.el.style.display = 'none';
  }
  set(offline: boolean) {
    clearTimeout(this.timer);
    if (offline) this.timer = window.setTimeout(() => (this.el.style.display = ''), 1500);
    else this.el.style.display = 'none';
  }
}
