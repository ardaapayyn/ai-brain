import type { GraphNode } from '../types';
import { h } from './dom';
import { icon, TYPE_ICON } from './icons';

export const TYPE_LABEL: Record<string, string> = { core: 'Nucleo', tool: 'Lobo strumenti', project: 'Progetto', module: 'Modulo', task: 'Task', memory: 'Memoria' };
export const TYPE_COLOR: Record<string, string> = { core: 'var(--fg)', tool: 'var(--cyan)', project: 'var(--violet)', module: 'var(--blue)', task: 'var(--pink)', memory: 'var(--amber)' };
export const STATUS_LABEL: Record<string, string> = { running: 'in esecuzione', active: 'attivo', done: 'completato', failed: 'fallito', cancelled: 'annullato' };
export const KIND_LABEL: Record<string, string> = { decision: 'decisione', fact: 'fatto', idea: 'idea', note: 'nota', preference: 'preferenza' };

/** Glass card that follows the cursor over 3D nodes. */
export class NodeTooltip {
  readonly el = h('div', { class: 'tip glass' });
  private current?: string;

  update(node: GraphNode | undefined, x: number, y: number) {
    if (!node) {
      if (this.current) this.el.classList.remove('on');
      this.current = undefined;
      return;
    }
    if (this.current !== node.id) {
      this.current = node.id;
      const status = node.type === 'task' && node.status ? ` · ${STATUS_LABEL[node.status] ?? node.status}` : node.type === 'memory' && node.kind ? ` · ${KIND_LABEL[node.kind] ?? node.kind}` : '';
      this.el.style.setProperty('--c', TYPE_COLOR[node.type]);
      this.el.replaceChildren(
        h('div', { class: 'k' }, icon(TYPE_ICON[node.type], 12), TYPE_LABEL[node.type] + status),
        h('div', { class: 'l' }, node.type === 'tool' ? node.label.charAt(0).toUpperCase() + node.label.slice(1) : node.label),
        h('div', { class: 'h' }, 'click per entrare'),
      );
      this.el.classList.add('on');
    }
    const w = this.el.offsetWidth, hgt = this.el.offsetHeight;
    const left = Math.min(x + 18, window.innerWidth - w - 12);
    const top = y + 18 + hgt > window.innerHeight - 12 ? y - hgt - 14 : y + 18;
    this.el.style.transform = `translate(${left}px, ${top}px)`;
  }
}
