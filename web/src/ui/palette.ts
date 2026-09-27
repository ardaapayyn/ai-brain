import type { GraphNode } from '../types';
import { h } from './dom';
import { icon, TYPE_ICON } from './icons';
import { KIND_LABEL, STATUS_LABEL, TYPE_COLOR } from './tooltip';

export interface PaletteAction {
  id: string;
  label: string;
  icon: string;
  hint?: string;
  run(): void;
}

interface Entry {
  group: string;
  label: string;
  icon: string;
  color?: string;
  hint?: string;
  run(): void;
}

/** Subsequence fuzzy match → score and highlighted HTML (or undefined when no match). */
export function fuzzy(query: string, text: string): { score: number; html: string } | undefined {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  if (!query) return { score: 0, html: esc(text) };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    return { score: 100 - direct + (direct === 0 ? 50 : 0), html: esc(text.slice(0, direct)) + '<mark>' + esc(text.slice(direct, direct + q.length)) + '</mark>' + esc(text.slice(direct + q.length)) };
  }
  let qi = 0;
  let score = 0;
  let html = '';
  let last = -2;
  for (let i = 0; i < text.length; i++) {
    if (qi < q.length && t[i] === q[qi]) {
      score += last === i - 1 ? 6 : 2;
      last = i;
      qi++;
      html += '<mark>' + esc(text[i]) + '</mark>';
    } else html += esc(text[i]);
  }
  return qi === q.length ? { score, html } : undefined;
}

export class CommandPalette {
  private wrap?: HTMLElement;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private entries: Entry[] = [];
  private shown: Entry[] = [];
  private index = 0;

  constructor(private source: () => { actions: PaletteAction[]; nodes: GraphNode[] }, private onNode: (id: string) => void) {}

  get open() {
    return !!this.wrap;
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    const { actions, nodes } = this.source();
    const groupOf: Record<string, string> = { project: 'Progetti', task: 'Task', memory: 'Ricordi', module: 'Moduli', tool: 'Strumenti', core: 'Nucleo' };
    this.entries = [
      ...actions.map((a) => ({ group: 'Azioni', label: a.label, icon: a.icon, hint: a.hint, run: a.run })),
      ...nodes
        .filter((n) => n.type !== 'core')
        .map((n) => ({
          group: groupOf[n.type],
          label: n.type === 'tool' ? n.label.charAt(0).toUpperCase() + n.label.slice(1) : n.label,
          icon: TYPE_ICON[n.type],
          color: TYPE_COLOR[n.type],
          hint: n.type === 'task' ? STATUS_LABEL[n.status ?? ''] : n.type === 'memory' ? KIND_LABEL[n.kind ?? ''] : undefined,
          run: () => this.onNode(n.id),
        })),
    ];
    this.input = h('input', { placeholder: 'Cerca progetti, task, ricordi o azioni…', spellcheck: false }) as HTMLInputElement;
    this.list = h('div', { class: 'pal-list scroll' });
    this.wrap = h(
      'div',
      { class: 'palette-wrap', onmousedown: (e: MouseEvent) => e.target === this.wrap && this.close() },
      h(
        'div',
        { class: 'palette glass' },
        h('div', { class: 'pal-input' }, icon('search', 18), this.input, h('span', { class: 'kbd' }, 'Esc')),
        this.list,
        h('div', { class: 'pal-foot' }, h('span', null, h('span', { class: 'kbd' }, '↑'), h('span', { class: 'kbd' }, '↓'), 'naviga'), h('span', null, h('span', { class: 'kbd' }, '⏎'), 'apri'), h('span', null, h('span', { class: 'kbd' }, 'Esc'), 'chiudi')),
      ),
    );
    this.input.addEventListener('input', () => {
      this.index = 0;
      this.render();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') this.move(1, e);
      else if (e.key === 'ArrowUp') this.move(-1, e);
      else if (e.key === 'Enter') {
        e.preventDefault();
        this.choose(this.shown[this.index]);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    document.getElementById('ui')!.append(this.wrap);
    this.render();
    setTimeout(() => this.input.focus());
  }

  close() {
    this.wrap?.remove();
    this.wrap = undefined;
  }

  private move(d: number, e: KeyboardEvent) {
    e.preventDefault();
    if (!this.shown.length) return;
    this.index = (this.index + d + this.shown.length) % this.shown.length;
    this.render();
  }

  private choose(entry?: Entry) {
    if (!entry) return;
    this.close();
    entry.run();
  }

  private render() {
    const q = this.input.value.trim();
    const scored = this.entries
      .map((e) => ({ e, m: fuzzy(q, e.label) }))
      .filter((x) => x.m)
      .sort((a, b) => (q ? b.m!.score - a.m!.score : 0));
    const limited = q ? scored.slice(0, 40) : scored.filter((x) => x.e.group !== 'Ricordi' && x.e.group !== 'Moduli').slice(0, 24);
    // keep groups together, in a stable order
    const order = ['Azioni', 'Progetti', 'Task', 'Ricordi', 'Moduli', 'Strumenti'];
    limited.sort((a, b) => order.indexOf(a.e.group) - order.indexOf(b.e.group) || (q ? b.m!.score - a.m!.score : 0));
    this.shown = limited.map((x) => x.e);
    if (!limited.length) {
      this.list.replaceChildren(h('div', { class: 'pal-empty' }, 'Nessun risultato'));
      return;
    }
    const out: HTMLElement[] = [];
    let group = '';
    limited.forEach((x, i) => {
      if (x.e.group !== group) {
        group = x.e.group;
        out.push(h('div', { class: 'pal-group' }, group));
      }
      const item = h(
        'div',
        { class: `pal-item ${i === this.index ? 'on' : ''}`, onmousemove: () => i !== this.index && ((this.index = i), this.render()), onclick: () => this.choose(x.e) },
        h('span', { class: 'ic', style: x.e.color ? `--c:${x.e.color}` : '' }, icon(x.e.icon, 15)),
        h('span', { class: 'lbl', html: x.m!.html }),
        x.e.hint ? h('small', null, x.e.hint) : null,
      );
      out.push(item);
    });
    this.list.replaceChildren(...out);
    this.list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
  }
}
