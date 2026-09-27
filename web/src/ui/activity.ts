import type { RunView, TimelineItem } from '../state';
import type { PlanStep } from '../types';
import { duration, h, markdown } from './dom';
import { CATEGORY_ICON, icon } from './icons';

export interface ActivityActions {
  close(): void;
  cancel(runId: string): void;
  revert(runId: string): void;
  approve(id: string, approved: boolean, scope: 'once' | 'run'): void;
  followUp(taskId: string): void;
}

export const CATEGORY_COLOR: Record<string, string> = {
  filesystem: 'var(--blue)',
  search: 'var(--cyan)',
  terminal: 'var(--amber)',
  git: '#fb923c',
  tests: 'var(--green)',
  web: 'var(--violet)',
  memory: 'var(--amber)',
  planning: 'var(--pink)',
};

const PHASE: Record<string, string> = {
  thinking: 'Sta pensando',
  loading: 'Carica il modello',
  reading: 'Legge il contesto',
  reasoning: 'Ragiona',
  writing: 'Scrive',
  tool: 'Sta agendo',
  waiting_approval: 'Attende conferma',
  verifying: 'Sta verificando',
};

const THINK_TITLE: Record<string, string> = {
  loading: 'Carico il modello in memoria',
  reading: 'Leggo il contesto',
  reasoning: 'Sto ragionando',
  thinking: 'Sto pensando',
  verifying: 'Controllo il lavoro',
};

/** Live "the model is working" card: neural waveform + real phase + elapsed time + reasoning preview. */
class ThinkingCard {
  readonly el = h('div', { class: 'think' });
  private title = h('div', { class: 'think-title' });
  private sub = h('div', { class: 'think-sub' });
  private preview = h('div', { class: 'think-preview' });
  private time = h('span', { class: 'think-time' });

  constructor() {
    const wave = h('div', { class: 'think-wave' });
    for (let i = 0; i < 32; i++) wave.append(h('i', { style: `animation-delay:${(-i * 0.09).toFixed(2)}s` }));
    this.el.append(h('div', { class: 'think-orb' }, h('span'), h('span'), h('span')), h('div', { class: 'think-body' }, h('div', { class: 'think-head' }, this.title, this.time), this.sub, wave, this.preview));
  }

  update(run: RunView) {
    const phase = run.phase ?? 'thinking';
    this.el.dataset.phase = phase;
    const secs = Math.max(0, Math.round((Date.now() - run.phaseSince) / 1000));
    this.title.textContent = THINK_TITLE[phase] ?? 'Sto pensando';
    this.time.textContent = `${secs}s`;
    const sub =
      phase === 'loading'
        ? `${run.phaseDetail ?? run.model} · solo al primo utilizzo, poi resta in memoria`
        : phase === 'reading'
          ? `${run.phaseDetail ?? ''}${run.phaseDetail ? ' · ' : ''}${run.mode === 'fast' ? 'modello veloce' : 'modello profondo'}`
          : phase === 'reasoning'
            ? 'il modello riflette prima di rispondere'
            : run.model;
    if (this.sub.textContent !== sub) this.sub.textContent = sub;
    const last = run.items.at(-1);
    const text = last?.kind === 'reasoning' && last.streaming ? last.text.replace(/\s+/g, ' ').trim().slice(-220) : '';
    this.preview.textContent = text;
    this.preview.style.display = text ? '' : 'none';
  }
}
const STATUS: Record<RunView['status'], [string, string]> = {
  running: ['Al lavoro', 'var(--amber)'],
  done: ['Completato', 'var(--green)'],
  failed: ['Non riuscito', 'var(--red)'],
  cancelled: ['Annullato', 'var(--fg-3)'],
};

interface ItemView {
  el: HTMLElement;
  sig: string;
}

/**
 * Live "what the AI is doing" panel. Rendering is incremental: each timeline item keeps its DOM
 * node and is patched only when it changes, so streaming stays smooth and expanded outputs,
 * scroll position and entry animations are preserved.
 */
export class ActivityPanel {
  readonly el = h('section', { class: 'panel right glass' });
  private head = h('header', { class: 'p-head' });
  private body = h('div', { class: 'p-body scroll' });
  private foot = h('footer', { class: 'p-foot' });
  private planWrap = h('div');
  private tl = h('div', { class: 'tl' });
  private thinking = new ThinkingCard();
  private reportWrap = h('div');
  private views: ItemView[] = [];
  private run?: RunView;
  private sigs = { plan: '', report: '', foot: '' };
  private dirty = false;
  private timer?: number;
  private open = new Set<string>();
  tps?: number;

  constructor(private a: ActivityActions) {
    this.el.style.display = 'none';
    this.body.append(this.planWrap, h('div', { class: 'eyebrow' }, icon('sparkles', 12), 'Attività'), this.tl, this.thinking.el, this.reportWrap);
    this.el.append(this.head, this.body, this.foot);
  }

  get visibleRunId() {
    return this.el.style.display === 'none' ? undefined : this.run?.runId;
  }

  show(run: RunView) {
    const changed = this.run?.runId !== run.runId;
    const hidden = this.el.style.display === 'none';
    this.run = run;
    if (changed) {
      this.views = [];
      this.tl.replaceChildren();
      this.sigs = { plan: '', report: '', foot: '' };
      this.open.clear();
    }
    if (hidden || changed) {
      this.el.style.display = '';
      this.el.style.animation = 'none';
      void this.el.offsetWidth;
      this.el.style.animation = '';
    }
    this.render(true);
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.run?.status === 'running' && this.invalidate(), 1000);
  }

  hide() {
    this.el.style.display = 'none';
    clearInterval(this.timer);
  }

  invalidate() {
    if (this.dirty || !this.run) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      this.render(false);
    });
  }

  private render(scrollToEnd: boolean) {
    const run = this.run!;
    const nearBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 90;
    this.renderHead(run);
    this.renderPlan(run.plan);
    this.renderTimeline(run);
    const last = run.items.at(-1);
    const writing = last?.kind === 'thought' && last.streaming;
    const thinking = run.status === 'running' && !['tool', 'waiting_approval', 'writing'].includes(run.phase ?? '') && !writing;
    this.thinking.el.style.display = thinking ? '' : 'none';
    if (thinking) this.thinking.update(run);
    this.renderReport(run);
    this.renderFoot(run);
    if (scrollToEnd || nearBottom) this.body.scrollTop = this.body.scrollHeight;
  }

  private renderHead(run: RunView) {
    const [label, color] = STATUS[run.status];
    const elapsed = (run.endedAt ?? Date.now()) - run.startedAt;
    this.head.replaceChildren(
      h(
        'div',
        { class: 'p-kicker' },
        h('span', { class: 'badge', style: `--c:${color}` }, h('span', { class: `dot ${run.status === 'running' ? 'busy' : run.status === 'done' ? 'ok' : run.status === 'failed' ? 'bad' : ''}` }), run.status === 'running' ? PHASE[run.phase ?? 'thinking'] ?? label : label),
      ),
      h('h2', { class: 'p-title', title: run.prompt }, run.prompt),
      h(
        'div',
        { class: 'p-meta' },
        h('span', null, icon(run.mode === 'fast' ? 'bolt' : 'cpu', 12), h('b', null, run.model)),
        h('span', null, icon('clock', 12), duration(elapsed)),
        h('span', null, icon('bolt', 12), `step ${run.step}`),
        run.status === 'running' && this.tps ? h('span', null, icon('gauge', 12), `${this.tps.toFixed(0)} tok/s`) : null,
      ),
      h('button', { class: 'btn sq ghost p-close', title: 'Chiudi  (Esc)', onclick: () => this.a.close() }, icon('x', 16)),
    );
  }

  private renderPlan(plan: PlanStep[]) {
    const sig = JSON.stringify(plan);
    if (sig === this.sigs.plan) return;
    this.sigs.plan = sig;
    if (!plan.length) return this.planWrap.replaceChildren();
    const done = plan.filter((s) => s.status === 'done').length;
    this.planWrap.replaceChildren(
      h('div', { class: 'eyebrow' }, icon('planning', 12), 'Piano', h('span', { class: 'n' }, `${done}/${plan.length}`)),
      h('div', { class: 'plan-bar' }, h('i', { style: `width:${(done / plan.length) * 100}%` })),
      renderPlan(plan),
    );
  }

  private renderTimeline(run: RunView) {
    const items = run.items;
    while (this.views.length > items.length) this.views.pop()!.el.remove();
    items.forEach((it, i) => {
      const sig = signature(it, run.status, this.open);
      const v = this.views[i];
      if (!v) {
        const el = this.build(it, run);
        el.classList.add('enter');
        this.tl.append(el);
        this.views[i] = { el, sig };
      } else if (v.sig !== sig) {
        this.patch(v.el, it, run);
        v.sig = sig;
      }
    });
  }

  private build(it: TimelineItem, run: RunView): HTMLElement {
    const el = h('div', { class: 'tl-item' });
    this.patch(el, it, run);
    return el;
  }

  /** (Re)fill an item's element in place. */
  private patch(el: HTMLElement, it: TimelineItem, run: RunView) {
    switch (it.kind) {
      case 'thought': {
        let body = el.querySelector<HTMLElement>('.tl-thought');
        if (!body) {
          el.replaceChildren(h('div', { class: 'tl-icon', style: '--c:var(--violet)' }, icon('sparkles', 14)), h('div', { class: 'tl-body' }, (body = h('div', { class: 'tl-thought md' }))));
        }
        body.innerHTML = markdown(it.text);
        body.classList.toggle('streaming', it.streaming);
        return;
      }
      case 'reasoning': {
        if (it.streaming) {
          // live reasoning is shown inside the thinking card; keep this slot empty until done
          el.className = 'tl-item tl-hidden';
          el.replaceChildren();
          return;
        }
        const words = it.text.trim().split(/\s+/).length;
        el.className = 'tl-item';
        el.replaceChildren(
          h('div', { class: 'tl-icon', style: '--c:var(--fg-3)' }, icon('sparkles', 14)),
          h(
            'div',
            { class: 'tl-body' },
            h(
              'button',
              {
                class: `reason ${it.open ? 'open' : ''}`,
                onclick: () => {
                  it.open = !it.open;
                  this.invalidate();
                },
              },
              `Ragionamento · ${words} parole`,
              icon('chevron', 13),
            ),
            it.open ? h('div', { class: 'reason-text' }, it.text.trim()) : null,
          ),
        );
        return;
      }
      case 'note':
        el.className = 'tl-item';
        el.replaceChildren(h('div', { class: 'tl-note', style: 'grid-column:1/-1' }, icon('refresh', 12), it.text));
        return;
      case 'tool': {
        const color = CATEGORY_COLOR[it.category] ?? 'var(--fg-2)';
        const out = it.status === 'running' ? it.live : it.preview || it.live;
        const isOpen = this.open.has(it.callId) || (it.status === 'running' && !!it.live) || (it.status === 'fail' && !this.open.has(it.callId + ':closed'));
        el.className = `tl-item ${it.status}`;
        let pre = el.querySelector<HTMLPreElement>('pre.tl-out');
        const stick = pre ? pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30 : true;
        const head = h(
          'div',
          {
            class: 'tl-head',
            onclick: () => {
              if (isOpen) {
                this.open.delete(it.callId);
                this.open.add(it.callId + ':closed');
              } else {
                this.open.add(it.callId);
                this.open.delete(it.callId + ':closed');
              }
              this.invalidate();
            },
          },
          h('span', { class: 'tl-name', title: it.summary }, it.summary),
          it.durationMs !== undefined ? h('span', { class: 'tl-dur' }, duration(it.durationMs)) : null,
          out ? icon('chevron', 14, 'tl-chev') : null,
        );
        if (isOpen && out) {
          if (!pre) pre = h('pre', { class: 'tl-out' }) as HTMLPreElement;
          if (pre.textContent !== out) pre.textContent = out;
          pre.classList.toggle('live', it.status === 'running');
        }
        const box = h('div', { class: `tl-tool ${isOpen && out ? 'open' : ''}` }, head, isOpen && out ? pre! : null);
        el.replaceChildren(h('div', { class: 'tl-icon', style: `--c:${it.status === 'fail' ? 'var(--red)' : color}` }, icon(it.status === 'fail' ? 'alert' : CATEGORY_ICON[it.category] ?? 'tool', 14)), h('div', { class: 'tl-body' }, box));
        if (pre && stick) pre.scrollTop = pre.scrollHeight;
        return;
      }
      case 'approval': {
        const ap = it.approval;
        el.className = 'tl-item';
        el.replaceChildren(
          h('div', { class: 'tl-icon', style: `--c:${ap.danger ? 'var(--red)' : 'var(--amber)'}` }, icon(ap.danger ? 'alert' : 'shield', 14)),
          h(
            'div',
            { class: 'tl-body' },
            h(
              'div',
              { class: `approval ${ap.danger ? 'danger' : ''} ${it.resolved ? 'resolved' : ''}` },
              h('div', { class: 'a-title' }, ap.danger ? 'Azione distruttiva' : 'Serve la tua conferma', h('span', { class: 'tool' }, ap.tool)),
              h('pre', null, ap.detail || ap.summary),
              it.resolved
                ? h('span', { class: 'verdict', style: `color:${it.approved ? 'var(--green)' : 'var(--red)'}` }, icon(it.approved ? 'check' : 'x', 14), it.approved ? 'Approvato' : 'Negato')
                : run.status === 'running'
                  ? approvalButtons(ap.id, ap.danger, this.a.approve, false)
                  : null,
            ),
          ),
        );
        return;
      }
    }
  }

  private renderReport(run: RunView) {
    const sig = `${run.summary ?? ''}|${run.status}|${run.filesTouched.join(',')}`;
    if (sig === this.sigs.report) return;
    this.sigs.report = sig;
    if (!run.summary) return this.reportWrap.replaceChildren();
    const title = run.status === 'done' ? 'Report' : run.status === 'failed' ? 'Non completato' : 'Interrotto';
    this.reportWrap.replaceChildren(
      h('div', { class: 'eyebrow' }, icon('check', 12), 'Risultato'),
      h('div', { class: `report ${run.status}` }, h('div', { class: 'report-head' }, icon(run.status === 'done' ? 'check' : run.status === 'failed' ? 'alert' : 'x', 16), title), h('div', { class: 'md', html: markdown(run.summary) })),
      ...(run.filesTouched.length
        ? [h('div', { class: 'eyebrow' }, icon('file', 12), 'File modificati', h('span', { class: 'n' }, String(run.filesTouched.length))), h('div', { class: 'files' }, ...run.filesTouched.map((f) => h('div', { class: 'file' }, icon('file', 13), f)))]
        : []),
    );
  }

  private renderFoot(run: RunView) {
    const sig = `${run.status}|${run.reverted}|${run.filesTouched.length}`;
    if (sig === this.sigs.foot) return;
    this.sigs.foot = sig;
    const children: (Node | null)[] = [
      run.status === 'running'
        ? h('button', { class: 'btn danger', onclick: () => this.a.cancel(run.runId) }, icon('stop', 14), 'Interrompi')
        : h('button', { class: 'btn primary', onclick: () => this.a.followUp(run.taskId) }, icon('followUp', 15), 'Continua questo task'),
      h('span', { class: 'spacer' }),
      run.status !== 'running' && run.filesTouched.length && !run.reverted
        ? h('button', { class: 'btn', title: 'Ripristina i file com’erano prima di questa esecuzione', onclick: () => this.a.revert(run.runId) }, icon('undo', 15), 'Annulla modifiche')
        : null,
      run.reverted ? h('span', { class: 'faint row', style: 'font-size:12px' }, icon('undo', 13), 'modifiche annullate') : null,
    ];
    this.foot.replaceChildren(...children.filter((c): c is Node => !!c));
  }
}

function signature(it: TimelineItem, status: string, open: Set<string>): string {
  switch (it.kind) {
    case 'thought':
      return `t|${it.text.length}|${it.streaming}`;
    case 'note':
      return `n|${it.text}`;
    case 'reasoning':
      return `r|${it.streaming}|${it.open}|${it.streaming ? 0 : it.text.length}`;
    case 'tool':
      return `x|${it.status}|${it.preview.length}|${it.live.length}|${it.durationMs}|${open.has(it.callId)}|${open.has(it.callId + ':closed')}`;
    case 'approval':
      return `a|${it.resolved}|${it.approved}|${status}`;
  }
}

export function approvalButtons(id: string, danger: boolean, approve: ActivityActions['approve'], shortcuts: boolean) {
  const k = (key: string) => (shortcuts ? h('span', { class: 'kbd' }, key) : null);
  return h(
    'div',
    { class: 'actions' },
    h('button', { class: 'btn', onclick: () => approve(id, false, 'once') }, icon('x', 14), 'Nega', k('N')),
    h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => approve(id, true, 'once') }, icon('check', 14), 'Consenti', danger ? null : k('Y')),
    danger ? null : h('button', { class: 'btn ghost', title: 'Non chiedere più per questo strumento in questa esecuzione', onclick: () => approve(id, true, 'run') }, 'Sempre in questa esecuzione', k('A')),
  );
}

export function renderPlan(plan: PlanStep[]) {
  return h(
    'ul',
    { class: 'plan' },
    ...plan.map((s) => h('li', { class: s.status }, h('span', { class: 'ck' }, s.status === 'done' ? icon('check', 11) : s.status === 'failed' ? icon('x', 11) : ''), h('span', null, s.title))),
  );
}
