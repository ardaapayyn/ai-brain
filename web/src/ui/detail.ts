import { api } from '../api';
import type { GraphNode } from '../types';
import { renderPlan } from './activity';
import { h, markdown, timeAgo } from './dom';
import { icon, TYPE_ICON } from './icons';
import { KIND_LABEL, STATUS_LABEL, TYPE_COLOR, TYPE_LABEL } from './tooltip';

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
  filesystem: ['Filesystem', 'Legge, crea, modifica ed elimina file del progetto. Ogni modifica viene salvata in uno snapshot e si può annullare.'],
  search: ['Ricerca e indice', 'Indicizza la codebase (linguaggi, framework, classi e funzioni) e cerca nel codice con ripgrep.'],
  terminal: ['Terminale', 'Esegue comandi non interattivi. Build, test e comandi di sola lettura partono subito; il resto chiede conferma.'],
  git: ['Git', 'Status, diff, log, branch e commit. I commit chiedono conferma; il push non viene mai fatto automaticamente.'],
  tests: ['Test', 'Rileva ed esegue la suite di test del progetto per verificare ogni modifica.'],
  web: ['Web', 'Ricerca sul web e lettura di pagine e documentazione, senza API key.'],
  memory: ['Memoria', 'Decisioni, fatti, idee e preferenze che il cervello ricorda tra un task e l’altro.'],
  planning: ['Pianificazione', 'Piani passo‑passo aggiornati in tempo reale durante i task.'],
};

const LANG_COLOR: Record<string, string> = {
  TypeScript: '#3b82f6', JavaScript: '#facc15', Python: '#22c55e', 'C#': '#a855f7', 'C++': '#ec4899', 'C/C++': '#f472b6', C: '#94a3b8',
  GDScript: '#38bdf8', Go: '#06b6d4', Rust: '#f97316', Java: '#ef4444', Kotlin: '#8b5cf6', Lua: '#6366f1', HTML: '#fb923c', CSS: '#60a5fa',
  JSON: '#a3a3a3', Markdown: '#e5e7eb', Shader: '#f0abfc', YAML: '#fca5a5',
};

/** Left panel: "entering" a node shows its project / task / memory / tool details. */
export class DetailPanel {
  readonly el = h('section', { class: 'panel left glass' });
  private current?: string;

  constructor(private a: DetailActions) {
    this.el.style.display = 'none';
  }

  get nodeId() {
    return this.current;
  }

  hide() {
    this.el.style.display = 'none';
    this.current = undefined;
  }

  /** `quiet` refreshes in place (no loading flash) — used when the graph changes underneath. */
  async show(node: GraphNode, quiet = false) {
    const changed = this.current !== node.id;
    this.current = node.id;
    if (this.el.style.display === 'none' || changed) {
      this.el.style.display = '';
      this.el.style.animation = 'none';
      void this.el.offsetWidth;
      this.el.style.animation = '';
    }
    if (!quiet) this.el.replaceChildren(this.head(node.type, node.label), h('div', { class: 'p-body' }, h('div', { class: 'spinner', style: 'margin-top:30px;width:26px;height:26px' })));
    try {
      const content = await this.render(node);
      if (this.current === node.id) this.el.replaceChildren(...content);
    } catch (err: any) {
      if (this.current === node.id) this.el.replaceChildren(this.head(node.type, node.label), h('div', { class: 'p-body' }, h('div', { class: 'empty' }, err.message)));
    }
  }

  private head(type: string, title: string, sub?: string | null, extra?: HTMLElement | null) {
    return h(
      'header',
      { class: 'p-head' },
      h(
        'div',
        { class: 'hero' },
        h('div', { class: 'hero-icon', style: `--c:${TYPE_COLOR[type]}` }, icon(TYPE_ICON[type] ?? 'sparkles', 22)),
        h('div', { style: 'min-width:0' }, h('div', { class: 'p-kicker' }, TYPE_LABEL[type] ?? type, sub ? h('span', { class: 'faint', style: 'letter-spacing:.06em;text-transform:none;font-weight:500' }, `· ${sub}`) : null), h('h2', { class: 'p-title' }, title)),
      ),
      extra ?? null,
      h('button', { class: 'btn sq ghost p-close', title: 'Chiudi  (Esc)', onclick: () => this.a.close() }, icon('x', 16)),
    );
  }

  private async render(node: GraphNode): Promise<HTMLElement[]> {
    const a = this.a;
    switch (node.type) {
      case 'project': {
        const d = await api.project(node.id);
        const langs = Object.entries(d.index.languages ?? {}).sort((x, y) => y[1] - x[1]);
        const total = langs.reduce((s, [, n]) => s + n, 0) || 1;
        const top = langs.slice(0, 6);
        const running = d.tasks.filter((t) => t.status === 'active').length;
        return [
          this.head('project', d.project.name, null, h('div', { class: 'path' }, d.project.path)),
          h(
            'div',
            { class: 'p-body scroll' },
            h(
              'div',
              { class: 'stats-grid' },
              h('div', { class: 'stat' }, h('div', { class: 'v' }, String(d.index.files ?? '–')), h('div', { class: 'k' }, 'file indicizzati')),
              h('div', { class: 'stat' }, h('div', { class: 'v' }, String(d.tasks.length)), h('div', { class: 'k' }, running ? `task · ${running} attivi` : 'task')),
              h('div', { class: 'stat' }, h('div', { class: 'v' }, String(d.memories.length)), h('div', { class: 'k' }, 'ricordi')),
            ),
            ...(d.index.error
              ? [h('div', { class: 'empty', style: 'margin-top:14px' }, d.index.error)]
              : [
                  h('div', { class: 'eyebrow' }, icon('module', 12), 'Codebase'),
                  top.length ? h('div', { class: 'langbar' }, ...top.map(([l, n], i) => h('i', { style: `width:${(n / total) * 100}%;--c:${LANG_COLOR[l] ?? 'var(--fg-3)'};animation-delay:${i * 60}ms`, title: l }))) : null,
                  h('div', { class: 'langs' }, ...top.map(([l, n]) => h('span', null, h('i', { style: `--c:${LANG_COLOR[l] ?? 'var(--fg-3)'}` }), l, h('b', null, String(n))))),
                  h(
                    'div',
                    { class: 'chips', style: 'margin-top:12px' },
                    ...(d.index.frameworks ?? []).map((f) => h('span', { class: 'badge', style: '--c:var(--violet)' }, f)),
                    h('span', { class: 'badge', style: `--c:${d.index.testCommand ? 'var(--green)' : 'var(--fg-3)'}` }, icon('tests', 11), d.index.testCommand ?? 'test non rilevati'),
                  ),
                ]),
            h('div', { class: 'eyebrow' }, icon('task', 12), 'Task', h('span', { class: 'n' }, String(d.tasks.length))),
            d.tasks.length
              ? h(
                  'div',
                  { class: 'list' },
                  ...d.tasks.slice(0, 40).map((t) =>
                    h(
                      'div',
                      { class: 'item', onclick: () => a.focusNode(t.id) },
                      h('span', { class: `dot st-${t.status}`, style: 'background:var(--c)' }),
                      h('div', { class: 't' }, t.title, h('div', { class: 's' }, STATUS_LABEL[t.status] ?? t.status, '·', timeAgo(t.updatedAt))),
                      icon('chevronRight', 15, 'go'),
                    ),
                  ),
                )
              : h('div', { class: 'empty' }, 'Nessun task ancora. Scrivi una richiesta nella barra in basso: l’agente lavorerà su questo progetto.'),
            h('div', { class: 'eyebrow' }, icon('memory', 12), 'Memoria', h('span', { class: 'n' }, String(d.memories.length))),
            ...this.memoryList(d.memories),
            this.noteInput(node),
          ),
          h(
            'footer',
            { class: 'p-foot' },
            h('button', { class: 'btn primary', onclick: () => a.useProject(node.id) }, icon('play', 13), 'Lavora qui'),
            h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  const r = await api.reindex(node.id);
                  a.toast(`Indicizzati ${r.files} file`);
                  this.show(node, true);
                },
              },
              icon('refresh', 14),
              'Reindicizza',
            ),
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn sq danger',
                title: 'Rimuovi dal cervello (i file NON vengono toccati)',
                onclick: async () => {
                  if (!a.confirm(`Rimuovere "${d.project.name}" dal cervello?\nI file su disco non verranno toccati.`)) return;
                  await api.removeProject(node.id);
                  a.useProject(null);
                  a.close();
                  a.refresh();
                },
              },
              icon('trash', 15),
            ),
          ),
        ];
      }
      case 'task': {
        const d = await api.task(node.id);
        const t = d.task;
        const status = node.status === 'running' ? 'running' : t.status;
        const lastRun = d.runs[0];
        const done = t.plan.filter((s) => s.status === 'done').length;
        return [
          this.head('task', t.title, STATUS_LABEL[status] ?? status),
          h(
            'div',
            { class: 'p-body scroll' },
            h(
              'div',
              { class: 'stats-grid' },
              h('div', { class: 'stat' }, h('div', { class: 'v' }, String(d.runs.length)), h('div', { class: 'k' }, 'esecuzioni')),
              h('div', { class: 'stat' }, h('div', { class: 'v' }, String(t.filesTouched.length)), h('div', { class: 'k' }, 'file toccati')),
              h('div', { class: 'stat' }, h('div', { class: 'v', style: 'font-size:14px;padding-top:6px' }, timeAgo(t.updatedAt)), h('div', { class: 'k' }, 'aggiornato')),
            ),
            ...(t.plan.length ? [h('div', { class: 'eyebrow' }, icon('planning', 12), 'Piano', h('span', { class: 'n' }, `${done}/${t.plan.length}`)), h('div', { class: 'plan-bar' }, h('i', { style: `width:${(done / t.plan.length) * 100}%` })), renderPlan(t.plan)] : []),
            ...(t.summary ? [h('div', { class: 'eyebrow' }, icon('check', 12), 'Ultimo report'), h('div', { class: `report ${t.status === 'failed' ? 'failed' : t.status === 'cancelled' ? 'cancelled' : ''}` }, h('div', { class: 'md', html: markdown(t.summary) }))] : []),
            ...(t.filesTouched.length ? [h('div', { class: 'eyebrow' }, icon('file', 12), 'File toccati'), h('div', { class: 'files' }, ...t.filesTouched.map((f) => h('div', { class: 'file' }, icon('file', 13), f)))] : []),
            h('div', { class: 'eyebrow' }, icon('clock', 12), 'Esecuzioni'),
            h(
              'div',
              { class: 'list' },
              ...d.runs.map((r) =>
                h(
                  'div',
                  { class: 'item', onclick: () => a.openRun(r.id) },
                  h('span', { class: `dot st-${r.status}`, style: 'background:var(--c)' }),
                  h('div', { class: 't' }, r.prompt.slice(0, 140), h('div', { class: 's' }, STATUS_LABEL[r.status] ?? r.status, '·', `${r.toolCalls.length} azioni`, '·', timeAgo(r.startedAt), r.reverted ? '· annullata' : '')),
                  icon('chevronRight', 15, 'go'),
                ),
              ),
            ),
          ),
          h(
            'footer',
            { class: 'p-foot' },
            h('button', { class: 'btn primary', onclick: () => a.followUp(t.id, t.title) }, icon('followUp', 15), 'Continua'),
            lastRun ? h('button', { class: 'btn', onclick: () => a.openRun(lastRun.id) }, icon('eye', 14), 'Attività') : null,
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn sq danger',
                title: 'Elimina il task dalla memoria',
                onclick: async () => {
                  if (!a.confirm('Eliminare questo task dalla memoria?')) return;
                  await api.removeTask(t.id);
                  a.close();
                  a.refresh();
                },
              },
              icon('trash', 15),
            ),
          ),
        ];
      }
      case 'memory':
        return [
          this.head('memory', KIND_LABEL[node.kind ?? 'note'] ?? 'Memoria'),
          h('div', { class: 'p-body' }, h('p', { style: 'font-size:15px;line-height:1.65;margin:18px 0 0' }, node.label)),
          h(
            'footer',
            { class: 'p-foot' },
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
              icon('trash', 14),
              'Dimentica',
            ),
          ),
        ];
      case 'tool': {
        const [title, desc] = TOOL_INFO[node.label] ?? [node.label, ''];
        return [
          this.head('tool', title),
          h('div', { class: 'p-body' }, h('p', { class: 'muted', style: 'line-height:1.65;margin-top:18px' }, desc), h('div', { class: 'callout' }, icon('sparkles', 15), h('span', null, 'Gli impulsi luminosi che raggiungono questo lobo mostrano quando l’agente sta usando questi strumenti.'))),
        ];
      }
      case 'module':
        return [
          this.head('module', node.label),
          h('div', { class: 'p-body' }, h('p', { class: 'muted', style: 'line-height:1.65;margin-top:18px' }, 'Cartella di primo livello del progetto.'), h('div', { class: 'callout' }, icon('sparkles', 15), h('span', null, 'Prova a chiedere: «Spiegami come funziona ', h('b', null, node.label), ' e come si collega al resto».'))),
        ];
      case 'core': {
        const [s, sys] = await Promise.all([api.status(), api.system().catch(() => undefined)]);
        return [
          this.head('core', 'AI Brain', s.llm.ok ? 'online' : 'modello non pronto'),
          h(
            'div',
            { class: 'p-body scroll' },
            h(
              'div',
              { class: 'stats-grid', style: 'grid-template-columns:1fr 1fr' },
              h('div', { class: 'stat' }, h('div', { class: 'v', style: 'font-size:14px;font-family:var(--mono)' }, s.model), h('div', { class: 'k' }, `modello · ${s.provider}`)),
              h('div', { class: 'stat' }, h('div', { class: 'v' }, `${Math.round(s.contextTokens / 1024)}K`), h('div', { class: 'k' }, 'contesto (token)')),
            ),
            sys ? h('div', { class: 'eyebrow' }, icon('cpu', 12), 'Questo PC') : null,
            sys
              ? h(
                  'div',
                  { class: 'sys' },
                  h('div', { class: 'stat' }, h('div', { class: 'v' }, sys.cpu), h('div', { class: 'k' }, `${sys.cores} thread`)),
                  h('div', { class: 'stat' }, h('div', { class: 'v' }, `${sys.ramGB} GB`), h('div', { class: 'k' }, 'RAM')),
                  ...sys.gpus.map((g) => h('div', { class: 'stat', style: 'grid-column:1/-1' }, h('div', { class: 'v' }, g.name), h('div', { class: 'k' }, g.vramGB ? `${g.vramGB} GB VRAM` : 'GPU'))),
                )
              : null,
            h('div', { class: 'eyebrow' }, icon('keyboard', 12), 'Scorciatoie'),
            h(
              'div',
              { class: 'md muted', html: markdown('- **Trascina** ruota · **scroll** zoom · **click** entra in un nodo · **doppio click** torna\n- `/` scrivi · `Ctrl K` cerca · `T` tema · `Esc` chiudi\n- Sulle conferme: `Y` consenti · `N` nega · `A` consenti per l’esecuzione') },
            ),
          ),
        ];
      }
    }
  }

  private memoryList(mems: { id: string; kind: string; text: string; createdAt: number }[]) {
    if (!mems.length) return [h('div', { class: 'empty' }, 'Nessun ricordo ancora. L’agente salva qui decisioni e convenzioni; puoi aggiungerne anche tu.')];
    return [
      h(
        'div',
        { class: 'list' },
        ...mems.slice(0, 50).map((m) =>
          h('div', { class: 'item', onclick: () => this.a.focusNode(m.id) }, h('span', { class: `badge kind-${m.kind}`, style: 'margin-top:1px' }, KIND_LABEL[m.kind] ?? m.kind), h('div', { class: 't' }, m.text)),
        ),
      ),
    ];
  }

  private noteInput(node: GraphNode) {
    const input = h('input', { class: 'input', placeholder: 'Aggiungi una nota o una decisione…' }) as HTMLInputElement;
    const save = async () => {
      const text = input.value.trim();
      if (!text) return;
      await api.addMemory({ projectId: node.id, kind: /^decis/i.test(text) ? 'decision' : /^idea/i.test(text) ? 'idea' : 'note', text });
      input.value = '';
      this.a.toast('Ricordo salvato');
      this.a.refresh();
      this.show(node, true);
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    return h('div', { class: 'note-input' }, input, h('button', { class: 'btn sq primary', title: 'Salva', onclick: save }, icon('plus', 16)));
  }
}
