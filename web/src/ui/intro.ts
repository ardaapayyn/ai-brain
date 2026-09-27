import { h } from './dom';
import { icon } from './icons';

/**
 * Boot overlay: logo draws itself, the title resolves letter by letter, and real boot checks
 * (server, model, projects) tick in while the neurons assemble behind it.
 */
export class Intro {
  readonly el: HTMLDivElement;
  private steps = h('div', { class: 'intro-steps' });
  private bar = h('i');
  private done = false;
  onSkip?: () => void;

  constructor() {
    const title = h('div', { class: 'intro-title' });
    'AI BRAIN'.split('').forEach((ch, i) => title.append(ch === ' ' ? h('span', { class: 'gap' }) : h('span', { style: `animation-delay:${0.25 + i * 0.07}s` }, ch)));
    this.el = h(
      'div',
      { class: 'intro', onclick: () => this.onSkip?.() },
      h(
        'div',
        { class: 'intro-inner' },
        icon('logo', 88, 'intro-logo'),
        title,
        h('div', { class: 'intro-sub' }, 'personal ai os'),
        h('div', { class: 'intro-bar' }, this.bar),
        this.steps,
      ),
      h('div', { class: 'intro-skip' }, 'click per saltare'),
    );
  }

  progress(p: number) {
    this.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`;
  }

  step(text: string, ok = true) {
    this.steps.append(h('div', null, h('span', { class: ok ? 'ok' : 'bad' }, ok ? '✓' : '!'), text));
    while (this.steps.children.length > 3) this.steps.firstElementChild?.remove();
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.progress(1);
    this.el.classList.add('out');
    setTimeout(() => this.el.remove(), 1300);
  }
}
