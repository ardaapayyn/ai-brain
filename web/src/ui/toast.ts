import { h } from './dom';
import { icon } from './icons';

const host = h('div', { class: 'toasts' });

export function mountToasts(parent: HTMLElement) {
  parent.append(host);
}

export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'ok') {
  const life = kind === 'error' ? 7000 : 3600;
  const el = h(
    'div',
    { class: `toast glass ${kind === 'error' ? 'error' : ''}`, style: `--life:${life}ms` },
    icon(kind === 'error' ? 'alert' : kind === 'info' ? 'sparkles' : 'check', 16),
    h('span', null, message),
    h('i', { class: 'life' }),
  );
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, life);
}
