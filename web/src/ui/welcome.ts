import { h } from './dom';
import { icon } from './icons';

/** First-run onboarding card (shown while no project is connected). */
export function welcomeCard(onAdd: () => void, onAsk: () => void) {
  const step = (n: string, color: string, title: string, text: string) => h('div', { class: 's' }, h('div', { class: 'n', style: `--c:${color}` }, icon(n, 16)), h('b', null, title), h('span', null, text));
  return h(
    'div',
    { class: 'welcome glass' },
    h('div', { class: 'eyebrow' }, icon('sparkles', 12), 'Benvenuto'),
    h('h1', null, 'Il tuo ', h('span', { class: 'grad-text' }, 'cervello digitale'), h('br'), 'è acceso.'),
    h('p', null, 'Collega un progetto e chiedi all’agente di analizzarlo, correggerlo o estenderlo. Lavora in autonomia, ti mostra ogni passo e tutto resta sul tuo PC.'),
    h(
      'div',
      { class: 'steps' },
      step('project', 'var(--violet)', 'Collega', 'Scegli la cartella: diventa un cluster di neuroni.'),
      step('sparkles', 'var(--cyan)', 'Chiedi', '«Analizza il progetto e sistema il combat system».'),
      step('eye', 'var(--pink)', 'Guarda', 'Piano, modifiche e test in tempo reale. Tutto annullabile.'),
    ),
    h('div', { class: 'row', style: 'justify-content:center;gap:10px' }, h('button', { class: 'btn primary', onclick: onAdd }, icon('plus', 16), 'Collega un progetto'), h('button', { class: 'btn', style: 'height:44px;border-radius:14px', onclick: onAsk }, 'Oppure chiedi subito')),
  );
}
