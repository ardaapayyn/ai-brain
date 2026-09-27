import type { RunView, TimelineItem } from '../state';
import type { PlanStep } from '../types';
import { duration, h, markdown } from './dom';

export interface ActivityActions {
  close(): void;
  cancel(runId: string): void;
  revert(runId: string): void;
  approve(id: string, approved: boolean, scope: 'once' | 'run'): void;
  followUp(taskId: string): void;
}

const PHASE: Record<string, string> = {
  thinking: 'sta pensando',
  tool: 'sta agendo',
  waiting_approval: 'attende la tua conferma',
  verifying: 'sta verificando',
};

const STATUS: Record<RunView['status'], string> = { running: 'in corso', done: 'completato', failed: 'fallito', cancelled: 'annullato' };

/** Live "what the AI is doing" panel: plan, streamed thoughts, tool calls, approvals, final report. */
export class ActivityPanel {
  readonly el = h('section', { class: 'panel right glass' });
  private body = h('div', { class: 'body scroll' });
  private run?: RunView;
  /** Items already on screen get no entry animation when the panel re-renders. */
  private seen = 0;
  private dirty = false;
  private timer?: number;

  constructor(private actions: ActivityActions) {
    this.el.style.display = 'none';
  }

  show(run: RunView) {
    const changed = this.run?.runId !== run.runId;
    this.run = run;
    if (this.el.style.display === 'none' || changed) {
      this.seen = 0;
      this.el.style.display = '';
      this.el.style.animation = 'none';
      void this.el.offsetWidth;
      this.el.style.animation = '';
      this.renderAll(true);
    } else this.invalidate();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.run?.status === 'running' && this.invalidate(), 1000);
  }

  hide() {
    this.el.style.display = 'none';
    this.run = undefined;
    clearInterval(this.timer);
  }

  get visibleRunId() {
    return this.el.style.display === 'none' ? undefined : this.run?.runId;
  }

  invalidate() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      this.renderAll(false);
    });
  }

  private renderAll(scrollToEnd: boolean) {
    const run = this.run;
    if (!run) return;
    const nearBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 80;
    const elapsed = (run.endedAt ?? Date.now()) - run.startedAt;
    const header = h(
      'header',
      null,
      h(
        'div',
        { class: 'kicker' },
        h('span', { class: `dot ${run.status === 'running' ? 'busy' : run.status === 'done' ? 'ok' : run.status === 'failed' ? 'bad' : ''}` }),
        run.status === 'running' ? `AI ${PHASE[run.phase ?? 'thinking'] ?? 'al lavoro'}` : STATUS[run.status],
        h('span', { class: 'spacer' }),
        `${duration(elapsed)} · step ${run.step}`,
      ),
      h('h2', null, run.prompt.length > 160 ? run.prompt.slice(0, 157) + '…' : run.prompt),
      h('div', { class: 'faint mono', style: 'margin-top:6px;font-size:10.5px' }, run.model),
      h('button', { class: 'btn icon close', title: 'Chiudi (Esc)', onclick: () => this.actions.close() }, '×'),
    );

    this.body.replaceChildren(
      ...(run.plan.length ? [h('div', { class: 'eyebrow' }, 'Piano'), renderPlan(run.plan)] : []),
      h('div', { class: 'eyebrow' }, 'Attività'),
      h(
        'div',
        { class: 'timeline' },
        ...run.items.map((it, i) => {
          const el = this.renderItem(it, run);
          if (i >= this.seen) el.classList.add('enter');
          return el;
        }),
      ),
      ...(run.status === 'running' && run.phase === 'thinking' && !run.items.some((i) => i.kind === 'thought' && i.streaming)
        ? [h('div', { class: 't-thought streaming faint' }, '')]
        : []),
      ...(run.summary
        ? [
            h('div', { class: 'eyebrow' }, 'Report'),
            h('div', { class: `t-final md ${run.status === 'failed' ? 'failed' : ''}`, html: markdown(run.summary) }),
            ...(run.filesTouched.length
              ? [h('div', { class: 'eyebrow' }, `File modificati (${run.filesTouched.length})`), h('div', { class: 'mono muted', style: 'line-height:1.7' }, ...run.filesTouched.map((f) => h('div', null, f)))]
              : []),
          ]
        : []),
    );

    const footer = h(
      'footer',
      null,
      run.status === 'running'
        ? h('button', { class: 'btn danger', onclick: () => this.actions.cancel(run.runId) }, '■ Interrompi')
        : h('button', { class: 'btn primary', onclick: () => this.actions.followUp(run.taskId) }, '↳ Continua questo task'),
      h('span', { class: 'spacer' }),
      run.status !== 'running' && run.filesTouched.length && !run.reverted
        ? h('button', { class: 'btn', title: 'Ripristina i file com’erano prima di questa esecuzione', onclick: () => this.actions.revert(run.runId) }, '↶ Annulla modifiche')
        : null,
      run.reverted ? h('span', { class: 'faint', style: 'font-size:12px' }, 'modifiche annullate') : null,
    );

    this.el.replaceChildren(header, this.body, footer);
    this.seen = run.items.length;
    if (scrollToEnd || nearBottom) this.body.scrollTop = this.body.scrollHeight;
  }

  private renderItem(it: TimelineItem, run: RunView): HTMLElement {
    switch (it.kind) {
      case 'thought':
        return h('div', { class: `t-thought md ${it.streaming ? 'streaming' : ''}`, html: markdown(it.text) });
      case 'note':
        return h('div', { class: 't-note' }, it.text);
      case 'tool': {
        const out = it.live && it.status === 'running' ? it.live : it.preview || it.live;
        const el = h(
          'div',
          { class: `t-tool ${it.status}` },
          h(
            'div',
            {
              class: 'head',
              onclick: () => {
                it.open = !it.open;
                this.invalidate();
              },
            },
            h('span', { class: `dot ${it.status === 'running' ? 'busy' : it.status === 'ok' ? 'ok' : 'bad'}` }),
            h('span', { class: 'name', title: it.summary }, it.summary),
            it.category ? h('span', { class: 'cat' }, it.category) : null,
            it.durationMs !== undefined ? h('span', { class: 'dur' }, duration(it.durationMs)) : null,
          ),
          it.open && out ? h('pre', null, out) : null,
        );
        return el;
      }
      case 'approval': {
        const a = it.approval;
        return h(
          'div',
          { class: `approval ${a.danger ? 'danger' : ''} ${it.resolved ? 'resolved' : ''}` },
          h('div', { class: 'title' }, a.danger ? '⚠ Azione distruttiva' : '◆ Conferma richiesta', h('span', { class: 'mono faint' }, a.tool)),
          h('pre', null, a.detail || a.summary),
          it.resolved
            ? h('div', { class: it.approved ? 'status-done' : 'status-failed', style: 'font-size:12px' }, it.approved ? '✓ approvato' : '✕ negato')
            : run.status === 'running'
              ? approvalButtons(a.id, a.danger, this.actions.approve)
              : null,
        );
      }
    }
  }
}

export function approvalButtons(id: string, danger: boolean, approve: ActivityActions['approve']) {
  return h(
    'div',
    { class: 'actions' },
    h('button', { class: 'btn', onclick: () => approve(id, false, 'once') }, 'Nega'),
    h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => approve(id, true, 'once') }, 'Consenti'),
    danger ? null : h('button', { class: 'btn', title: 'Non chiedere più per questo strumento in questa esecuzione', onclick: () => approve(id, true, 'run') }, 'Consenti per questa esecuzione'),
  );
}

export function renderPlan(plan: PlanStep[]) {
  return h(
    'ul',
    { class: 'plan' },
    ...plan.map((s) => h('li', { class: s.status }, h('span', { class: 'ck' }, s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : ''), h('span', null, s.title))),
  );
}
