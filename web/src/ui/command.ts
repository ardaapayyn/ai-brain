import type { RunView } from '../state';
import type { Project } from '../types';
import { h } from './dom';
import { icon } from './icons';

const SUGGESTIONS: [string, string, string][] = [
  ['search', 'Analizza il progetto', 'Analizza il progetto: struttura, punti deboli e cosa miglioreresti per primo.'],
  ['bolt', 'Trova e correggi bug', 'Trova i bug più probabili nel progetto, correggili e verifica con i test.'],
  ['tests', 'Scrivi i test mancanti', 'Individua le parti più importanti senza test, scrivi i test e falli passare.'],
  ['module', 'Spiega l’architettura', 'Spiegami l’architettura del progetto: moduli principali, flusso dei dati e dipendenze.'],
  ['gauge', 'Migliora le performance', 'Trova i colli di bottiglia di performance più evidenti e proponi/applica le ottimizzazioni.'],
];

const PHASE: Record<string, string> = { thinking: 'Sta pensando', tool: 'Sta eseguendo', waiting_approval: 'Attende la tua conferma', verifying: 'Sta verificando' };

export interface CommandActions {
  submit(prompt: string): Promise<boolean>;
  stop(runId: string): void;
  chooseProject(id: string | null): void;
  addProject(): void;
  clearFollow(): void;
}

/** The floating prompt bar: context chips, suggestions, live run status, animated aura. */
export class CommandBar {
  readonly el = h('div', { class: 'command glass' });
  readonly textarea = h('textarea', { rows: 1, placeholder: 'Chiedi qualcosa al tuo cervello…', spellcheck: false }) as HTMLTextAreaElement;
  private top = h('div', { class: 'cmd-ctx' });
  private follow = h('div', { class: 'cmd-follow' });
  private suggestions = h('div', { class: 'suggestions' });
  private status = h('div', { class: 'cmd-status' });
  private send = h('button', { class: 'send idle', title: 'Invia  (Enter)' }) as HTMLButtonElement;
  private run?: RunView;
  private projects: Project[] = [];
  private projectId: string | null = null;
  private followTitle?: string;
  private busy = false;

  constructor(private a: CommandActions) {
    this.send.append(icon('arrowUp', 19));
    this.el.append(h('div', { class: 'aura' }), this.suggestions, this.follow, h('div', { class: 'cmd-row' }, this.top, this.textarea, this.send), this.status);
    this.follow.style.display = 'none';
    this.status.style.display = 'none';
    this.suggestions.style.display = 'none';
    this.textarea.addEventListener('input', () => this.onInput());
    this.textarea.addEventListener('focus', () => {
      this.el.classList.add('focus');
      this.renderSuggestions();
    });
    this.textarea.addEventListener('blur', () => {
      this.el.classList.remove('focus');
      setTimeout(() => this.renderSuggestions(), 150);
    });
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.fire();
      }
    });
    this.send.addEventListener('click', () => this.fire());
    this.renderTop();
  }

  focus() {
    this.textarea.focus();
  }

  setContext(projects: Project[], projectId: string | null, followTitle?: string) {
    this.projects = projects;
    this.projectId = projectId;
    this.followTitle = followTitle;
    this.renderTop();
  }

  /** The run that belongs to the current context (drives stop button + status line). */
  setRun(run: RunView | undefined, tps?: number) {
    this.run = run?.status === 'running' ? run : undefined;
    const busy = !!this.run;
    if (busy !== this.busy) {
      this.busy = busy;
      this.el.classList.toggle('busy', busy);
      this.send.classList.toggle('stop', busy);
      this.send.replaceChildren(icon(busy ? 'stop' : 'arrowUp', busy ? 17 : 19));
      this.send.title = busy ? 'Interrompi' : 'Invia  (Enter)';
      this.status.style.display = busy ? '' : 'none';
      this.onInput();
    }
    if (this.run) {
      const r = this.run;
      const lastTool = [...r.items].reverse().find((i) => i.kind === 'tool');
      const what = r.phase === 'tool' && lastTool?.kind === 'tool' ? lastTool.summary : r.phase === 'waiting_approval' ? r.phaseDetail ?? '' : '';
      const parts: (Node | null)[] = [
        h('span', { class: 'mini-spin' }),
        h('span', { class: 'what' }, `${PHASE[r.phase ?? 'thinking'] ?? 'Al lavoro'}${what ? ': ' : '…'}`, what ? h('b', null, what) : null),
        tps ? h('span', { class: 'step' }, `${tps.toFixed(0)} tok/s`) : null,
        h('span', { class: 'step' }, `step ${r.step}`),
      ];
      this.status.replaceChildren(...parts.filter((c): c is Node => !!c));
    }
  }

  private onInput() {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = Math.min(this.textarea.scrollHeight, 200) + 'px';
    this.send.classList.toggle('idle', !this.busy && !this.textarea.value.trim());
    this.renderSuggestions();
  }

  private renderSuggestions() {
    const show = !this.busy && document.activeElement === this.textarea && !this.textarea.value.trim();
    if (show && this.suggestions.style.display === 'none') {
      this.suggestions.replaceChildren(
        ...SUGGESTIONS.map(([ic, label, prompt], i) =>
          h(
            'button',
            {
              class: 'chip',
              style: `animation-delay:${i * 45}ms`,
              onmousedown: (e: MouseEvent) => {
                e.preventDefault();
                this.textarea.value = prompt;
                this.onInput();
                this.textarea.focus();
              },
            },
            icon(ic, 13),
            label,
          ),
        ),
      );
    }
    this.suggestions.style.display = show ? '' : 'none';
  }

  private async fire() {
    if (this.run) return this.a.stop(this.run.runId);
    const prompt = this.textarea.value.trim();
    if (!prompt) return this.textarea.focus();
    this.send.disabled = true;
    const ok = await this.a.submit(prompt);
    this.send.disabled = false;
    if (ok) {
      this.textarea.value = '';
      this.onInput();
    }
  }

  private renderTop() {
    const project = this.projects.find((p) => p.id === this.projectId);
    const chip = h('button', { class: 'ctx-chip', title: 'Dove lavora l’agente' }, icon(project ? 'project' : 'sparkles', 14), h('span', null, project ? project.name : 'Ovunque'), icon('chevron', 12));
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });
    this.top.replaceChildren(chip);
    this.follow.style.display = this.followTitle ? '' : 'none';
    if (this.followTitle)
      this.follow.replaceChildren(h('button', { class: 'chip', title: 'Il prossimo messaggio continua questo task — clic per annullare', onclick: () => this.a.clearFollow() }, icon('followUp', 13), `Continua: ${this.followTitle}`, icon('x', 12)));
  }

  private toggleMenu() {
    const existing = this.top.querySelector('.menu');
    if (existing) return existing.remove();
    const choose = (id: string | null) => {
      menu.remove();
      this.a.chooseProject(id);
    };
    const menu = h(
      'div',
      { class: 'menu glass scroll' },
      ...this.projects.map((p) => h('button', { class: p.id === this.projectId ? 'on' : '', onclick: () => choose(p.id) }, icon('project', 15), p.name, p.id === this.projectId ? h('small', null, 'attivo') : null)),
      h('button', { class: this.projectId === null ? 'on' : '', onclick: () => choose(null) }, icon('sparkles', 15), 'Ovunque', h('small', null, 'nessun progetto')),
      h('hr'),
      h('button', { onclick: () => (menu.remove(), this.a.addProject()) }, icon('folderPlus', 15), 'Aggiungi progetti…'),
    );
    this.top.append(menu);
    const off = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', off);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', off));
  }
}
