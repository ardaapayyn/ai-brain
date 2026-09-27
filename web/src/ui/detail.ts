import { api } from '../api';
import type { GraphNode } from '../types';
import { renderPlan } from './activity';
import { h, markdown, timeAgo } from './dom';

export interface DetailActions {
  close(): void;
  focusNode(id: string): void;
  useProject(id: string | null): void;
  followUp(taskId: string, title: string): void;
  openRun(runId: string): void;
  toast(msg: string, error?: boolean): void;
  refresh(): void;
  confirm(msg: string): boolean;
}

const TOOL_INFO: Record<string, [string, string]> = {
  filesystem: ['Filesystem', 'Legge, crea, modifica ed elimina file del progetto (con snapshot per annullare).'],
  search: ['Ricerca & indice', 'Indicizza la codebase (linguaggi, simboli, framework) e cerca nel codice.'],
  terminal: ['Terminale', 'Esegue comandi shell non interattivi; quelli non banali chiedono conferma.'],
  git: ['Git', 'Status, diff, log, branch e commit (i commit chiedono conferma, mai push).'],
  tests: ['Test', 'Rileva ed esegue la suite di test del progetto per verificare le modifiche.'],
  web: ['Web', 'Ricerca sul web e lettura di pagine/documentazione.'],
  memory: ['Memoria', 'Decisioni, fatti, idee e preferenze che il cervello ricorda tra un task e l’altro.'],
  planning: ['Pianificazione', 'Piani passo-passo aggiornati in tempo reale durante i task.'],
};

const KIND_LABEL: Record<string, string> = { decision: 'decisione', fact: 'fatto', idea: 'idea', note: 'nota', preference: 'preferenza' };

/** Left panel: "entering" a node shows its project / task / memory / tool details. */
export class DetailPanel {
  readonly el = h('section', { class: 'panel left glass' });
  private current?: string;

  constructor(private actions: DetailActions) {
    this.el.style.display = 'none';
  }

  hide() {
    this.el.style.display = 'none';
    this.current = undefined;
  }

  get nodeId() {
    return this.current;
  }

  /** `quiet` refreshes in place (no loading flash) — used when the graph changes underneath. */
  async show(node: GraphNode, quiet = false) {
    this.current = node.id;
    this.el.style.display = '';
    if (!quiet) this.el.replaceChildren(this.header(node.type, node.label), h('div', { class: 'body faint' }, 'caricamento…'));
    try {
      const content = await this.render(node);
      if (this.current === node.id) this.el.replaceChildren(...content);
    } catch (err: any) {
      if (this.current === node.id) this.el.replaceChildren(this.header(node.type, node.label), h('div', { class: 'body status-failed' }, err.message));
    }
  }

  private header(type: string, title: string, extra?: HTMLElement | null) {
    const kind: Record<string, string> = { core: 'nucleo', tool: 'lobo strumenti', project: 'progetto', module: 'modulo', task: 'task', memory: 'memoria' };
    return h(
      'header',
      null,
      h('div', { class: 'kicker' }, kind[type] ?? type),
      h('h2', null, title),
      extra ?? null,
      h('button', { class: 'btn icon close', title: 'Chiudi (Esc)', onclick: () => this.actions.close() }, '×'),
    );
  }

  private async render(node: GraphNode): Promise<HTMLElement[]> {
    const a = this.actions;
    switch (node.type) {
      case 'project': {
        const d = await api.project(node.id);
        const langs = Object.entries(d.index.languages ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 6);
        return [
          this.header('project', d.project.name, h('div', { class: 'mono faint', style: 'margin-top:6px;font-size:11px;word-break:break-all' }, d.project.path)),
          h(
            'div',
            { class: 'body scroll' },
            h('div', { class: 'eyebrow' }, 'Codebase'),
            d.index.error
              ? h('div', { class: 'status-failed' }, d.index.error)
              : h(
                  'dl',
                  { class: 'kv' },
                  h('dt', null, 'File'), h('dd', null, String(d.index.files ?? '–')),
                  h('dt', null, 'Linguaggi'), h('dd', null, langs.map(([l, n]) => `${l} ${n}`).join(' · ') || '–'),
                  h('dt', null, 'Framework'), h('dd', null, d.index.frameworks?.join(', ') || '–'),
                  h('dt', null, 'Test'), h('dd', { class: 'mono' }, d.index.testCommand ?? 'non rilevati'),
                ),
            h('div', { class: 'eyebrow' }, `Task (${d.tasks.length})`),
            d.tasks.length
              ? h(
                  'div',
                  { class: 'list' },
                  ...d.tasks.slice(0, 40).map((t) =>
                    h('div', { class: 'item', onclick: () => a.focusNode(t.id) }, h('div', { class: 't' }, t.title, h('div', { class: 's' }, h('span', { class: `status-${t.status}` }, t.status), ' · ', timeAgo(t.updatedAt)))),
                  ),
                )
              : h('div', { class: 'faint' }, 'Nessun task. Scrivi una richiesta nella barra in basso.'),
            h('div', { class: 'eyebrow' }, `Memoria (${d.memories.length})`),
            ...this.memoryList(d.memories),
            h(
              'div',
              { class: 'row', style: 'margin-top:10px' },
              h('input', {
                class: 'input',
                placeholder: 'Aggiungi una nota/decisione…',
                onkeydown: async (e: KeyboardEvent) => {
                  const input = e.target as HTMLInputElement;
                  if (e.key !== 'Enter' || !input.value.trim()) return;
                  await api.addMemory({ projectId: node.id, kind: input.value.toLowerCase().startsWith('decis') ? 'decision' : 'note', text: input.value.trim() });
                  input.value = '';
                  a.refresh();
                  this.show(node);
                },
              }),
            ),
          ),
          h(
            'footer',
            null,
            h('button', { class: 'btn primary', onclick: () => a.useProject(node.id) }, '◈ Lavora su questo progetto'),
            h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  const r = await api.reindex(node.id);
                  a.toast(`Indicizzati ${r.files} file`);
                  this.show(node);
                },
              },
              '↻ Reindicizza',
            ),
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn danger',
                title: 'Rimuove il progetto dal cervello (i file NON vengono toccati)',
                onclick: async () => {
                  if (!a.confirm(`Rimuovere "${d.project.name}" dal cervello? I file su disco non verranno toccati.`)) return;
                  await api.removeProject(node.id);
                  a.useProject(null);
                  a.close();
                  a.refresh();
                },
              },
              'Rimuovi',
            ),
          ),
        ];
      }
      case 'task': {
        const d = await api.task(node.id);
        const t = d.task;
        const lastRun = d.runs[0];
        return [
          this.header('task', t.title, h('div', { class: 'faint', style: 'margin-top:6px;font-size:11.5px' }, h('span', { class: `status-${node.status === 'running' ? 'running' : t.status}` }, node.status === 'running' ? 'in corso' : t.status), ` · ${d.runs.length} esecuzioni · ${timeAgo(t.updatedAt)}`)),
          h(
            'div',
            { class: 'body scroll' },
            ...(t.plan.length ? [h('div', { class: 'eyebrow' }, 'Piano'), renderPlan(t.plan)] : []),
            ...(t.summary ? [h('div', { class: 'eyebrow' }, 'Ultimo report'), h('div', { class: 't-final md', html: markdown(t.summary) })] : []),
            ...(t.filesTouched.length ? [h('div', { class: 'eyebrow' }, 'File toccati'), h('div', { class: 'mono muted', style: 'line-height:1.7' }, ...t.filesTouched.map((f) => h('div', null, f)))] : []),
            h('div', { class: 'eyebrow' }, 'Esecuzioni'),
            h(
              'div',
              { class: 'list' },
              ...d.runs.map((r) =>
                h(
                  'div',
                  { class: 'item', onclick: () => a.openRun(r.id) },
                  h('div', { class: 't' }, r.prompt.slice(0, 120), h('div', { class: 's' }, h('span', { class: `status-${r.status}` }, r.status), ` · ${r.toolCalls.length} azioni · ${timeAgo(r.startedAt)}${r.reverted ? ' · annullata' : ''}`)),
                ),
              ),
            ),
          ),
          h(
            'footer',
            null,
            h('button', { class: 'btn primary', onclick: () => a.followUp(t.id, t.title) }, '↳ Continua'),
            lastRun ? h('button', { class: 'btn', onclick: () => a.openRun(lastRun.id) }, 'Mostra attività') : null,
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn danger',
                onclick: async () => {
                  if (!a.confirm('Eliminare questo task dalla memoria?')) return;
                  await api.removeTask(t.id);
                  a.close();
                  a.refresh();
                },
              },
              'Elimina',
            ),
          ),
        ];
      }
      case 'memory': {
        return [
          this.header('memory', KIND_LABEL[node.kind ?? 'note'] ?? 'memoria'),
          h('div', { class: 'body' }, h('p', { style: 'font-size:14px;line-height:1.6' }, node.label)),
          h(
            'footer',
            null,
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn danger',
                onclick: async () => {
                  await api.removeMemory(node.id);
                  a.close();
                  a.refresh();
                },
              },
              'Dimentica',
            ),
          ),
        ];
      }
      case 'tool': {
        const [title, desc] = TOOL_INFO[node.label] ?? [node.label, ''];
        return [this.header('tool', title), h('div', { class: 'body' }, h('p', { class: 'muted', style: 'line-height:1.6' }, desc), h('p', { class: 'faint', style: 'font-size:12px' }, 'Gli impulsi luminosi verso questo lobo indicano che l’agente sta usando questi strumenti.'))];
      }
      case 'module':
        return [this.header('module', node.label), h('div', { class: 'body' }, h('p', { class: 'muted' }, 'Cartella di primo livello del progetto. Chiedi all’agente di analizzarla, ad es. «Spiegami come è strutturato ', h('span', { class: 'mono' }, node.label), '».'))];
      case 'core': {
        const s = await api.status();
        return [
          this.header('core', 'AI Brain'),
          h(
            'div',
            { class: 'body' },
            h(
              'dl',
              { class: 'kv' },
              h('dt', null, 'Modello'), h('dd', { class: 'mono' }, s.model),
              h('dt', null, 'Provider'), h('dd', null, s.provider),
              h('dt', null, 'Contesto'), h('dd', null, `${s.contextTokens.toLocaleString()} token`),
              h('dt', null, 'Stato'), h('dd', { class: s.llm.ok ? 'status-done' : 'status-failed' }, s.llm.detail),
              h('dt', null, 'Esecuzioni'), h('dd', null, String(s.activeRuns.length)),
            ),
            h('div', { class: 'eyebrow' }, 'Come si usa'),
            h(
              'div',
              { class: 'md muted', html: markdown('- **Trascina** per ruotare, **scroll** per lo zoom, **click** su un nodo per entrarci, **doppio click** sul vuoto per tornare\n- Premi **/** per scrivere, **Esc** per chiudere i pannelli\n- Aggiungi un progetto con **+** in alto a destra, poi chiedi ad es. «Analizza il progetto e sistema il combat system»') },
            ),
          ),
        ];
      }
    }
  }

  private memoryList(mems: { id: string; kind: string; text: string; createdAt: number }[]) {
    if (!mems.length) return [h('div', { class: 'faint' }, 'Ancora nessun ricordo per questo progetto.')];
    return [
      h(
        'div',
        { class: 'list' },
        ...mems.slice(0, 50).map((m) =>
          h(
            'div',
            { class: 'item', onclick: () => this.actions.focusNode(m.id) },
            h('span', { class: `tag ${m.kind}` }, KIND_LABEL[m.kind] ?? m.kind),
            h('div', { class: 't' }, m.text),
          ),
        ),
      ),
    ];
  }
}
