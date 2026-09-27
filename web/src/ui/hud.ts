import { h } from './dom';
import { icon } from './icons';
import { TYPE_COLOR } from './tooltip';

/** Brand + live status pill with a neural-activity sparkline and tokens/s. */
export class HudLeft {
  readonly el: HTMLDivElement;
  private dot = h('span', { class: 'dot' });
  private model = h('span', { class: 'model' }, '…');
  private metric = h('span', { class: 'metric' });
  private canvas = h('canvas', { width: 140, height: 44 }) as HTMLCanvasElement;
  private history: number[] = new Array(48).fill(0);

  constructor(onStatusClick: () => void, onBrandClick: () => void) {
    this.el = h(
      'div',
      { class: 'hud-left' },
      h('div', { class: 'brand', onclick: onBrandClick, title: 'Vista d’insieme' }, icon('logo', 30, 'mark'), h('span', { class: 'brand-name' }, 'AI BRAIN')),
      h('div', { class: 'status glass', onclick: onStatusClick, title: 'Modello e impostazioni' }, this.dot, this.model, h('span', { class: 'sep' }), this.canvas, this.metric),
    );
  }

  setStatus(s: { connected: boolean; ok: boolean; model?: string; busy: boolean }) {
    this.dot.className = `dot ${!s.connected ? 'bad' : s.busy ? 'busy' : s.ok ? 'ok' : 'bad'}`;
    this.model.textContent = !s.connected ? 'offline' : s.model ?? '…';
  }

  setMetric(tps: number | undefined, idleText: string) {
    this.metric.replaceChildren(...(tps !== undefined ? [h('b', null, tps.toFixed(0)), ' tok/s'] : [idleText]));
  }

  /** Call ~10×/s with the scene activity (0..1). */
  pushActivity(level: number, color: string) {
    this.history.push(level);
    this.history.shift();
    const ctx = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'rgba(167,139,250,0)');
    grad.addColorStop(0.4, color);
    grad.addColorStop(1, '#67e8f9');
    ctx.beginPath();
    this.history.forEach((v, i) => {
      const x = (i / (this.history.length - 1)) * W;
      const y = H - 5 - v * (H - 10) - Math.sin(i * 0.9 + performance.now() / 300) * 1.5 * (0.3 + v);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, 0, H);
    fill.addColorStop(0, 'rgba(167,139,250,0.22)');
    fill.addColorStop(1, 'rgba(167,139,250,0)');
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

export interface HudActions {
  palette(): void;
  addProject(): void;
  home(): void;
  toggleTheme(): void;
  settings(): void;
}

export class HudRight {
  readonly el: HTMLDivElement;
  private themeBtn: HTMLButtonElement;

  constructor(a: HudActions, theme: 'dark' | 'light') {
    this.themeBtn = h('button', { class: 'btn sq', 'data-tip': 'Tema chiaro/scuro  (T)', onclick: a.toggleTheme }) as HTMLButtonElement;
    this.setTheme(theme);
    const isMac = /Mac/.test(navigator.platform);
    this.el = h(
      'div',
      { class: 'hud-right glass' },
      h('button', { class: 'btn', 'data-tip': `Cerca e comandi  (${isMac ? '⌘' : 'Ctrl'}+K)`, onclick: a.palette }, icon('search', 15), h('span', { class: 'kbd' }, isMac ? '⌘K' : 'Ctrl K')),
      h('button', { class: 'btn', 'data-tip': 'Collega una cartella progetto', onclick: a.addProject }, icon('plus', 15), 'Progetto'),
      h('button', { class: 'btn sq', 'data-tip': 'Vista d’insieme  (doppio click)', onclick: a.home }, icon('target', 16)),
      this.themeBtn,
      h('button', { class: 'btn sq', 'data-tip': 'Impostazioni', onclick: a.settings }, icon('settings', 16)),
    );
  }

  setTheme(theme: 'dark' | 'light') {
    this.themeBtn.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon', 16));
  }
}

const LEGEND: { type: string; label: string }[] = [
  { type: 'project', label: 'Progetti' },
  { type: 'module', label: 'Moduli' },
  { type: 'task', label: 'Task' },
  { type: 'memory', label: 'Memorie' },
  { type: 'tool', label: 'Strumenti' },
];

/** Clickable legend: shows what each colour is and toggles node types on/off. */
export class Legend {
  readonly el = h('div', { class: 'legend glass' });
  constructor(private hidden: Set<string>, private onChange: (hidden: Set<string>) => void) {}

  render(counts: Record<string, number>) {
    this.el.replaceChildren(
      h('div', { class: 'title' }, 'Mappa'),
      ...LEGEND.map((l) =>
        h(
          'button',
          {
            class: this.hidden.has(l.type) ? 'off' : '',
            title: this.hidden.has(l.type) ? 'Mostra' : 'Nascondi',
            onclick: () => {
              this.hidden.has(l.type) ? this.hidden.delete(l.type) : this.hidden.add(l.type);
              this.onChange(this.hidden);
              this.render(counts);
            },
          },
          h('i', { style: `--c:${TYPE_COLOR[l.type]}` }),
          l.label,
          h('span', { class: 'n' }, String(counts[l.type] ?? 0)),
        ),
      ),
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
      h('p', null, 'Mi riconnetto automaticamente. Se non torna, avvia AI Brain con ', h('code', null, 'AI-Brain.bat'), ' (o ', h('code', null, 'npm run dev'), ').'),
    ),
  );
  private timer?: number;
  constructor() {
    this.el.style.display = 'none';
  }
  /** Shown only if the connection stays down for a moment (no flash on quick reconnects). */
  set(offline: boolean) {
    clearTimeout(this.timer);
    if (offline) this.timer = window.setTimeout(() => (this.el.style.display = ''), 1500);
    else this.el.style.display = 'none';
  }
}
