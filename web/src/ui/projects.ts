import { api } from '../api';
import type { FolderInfo, Project } from '../types';
import { h } from './dom';
import { icon } from './icons';
import { modal } from './modals';
import { fuzzy } from './palette';

const KIND_COLOR: Record<string, string> = {
  Unity: '#e5e7eb', Unreal: '#94a3b8', Godot: '#60a5fa', 'Node.js': '#4ade80', Python: '#facc15', Rust: '#fb923c', Go: '#22d3ee',
  '.NET': '#a78bfa', Flutter: '#38bdf8', 'Java/Kotlin': '#f87171', 'C/C++': '#f472b6', PHP: '#818cf8', Ruby: '#fb7185', Git: '#fdba74',
};

export interface PickerOptions {
  onDone(added: Project[], existing: Project[]): void;
  toast(msg: string, error?: boolean): void;
  tab?: 'discover' | 'browse';
}

/**
 * Multi-select project picker: auto-discovered projects on this PC + a folder browser.
 * Select as many folders as you like, then connect them in one go.
 */
export function openProjectPicker(o: PickerOptions) {
  const selected = new Map<string, FolderInfo>();
  let tab: 'discover' | 'browse' = o.tab ?? 'discover';
  let discovered: FolderInfo[] | undefined;
  let discoverError = '';
  let filter = '';
  let browseState: { path: string; parent?: string; folders: FolderInfo[]; roots: FolderInfo[] } | undefined;
  let browseError = '';

  const body = h('div', { class: 'picker' });
  const tabs = h('div', { class: 'tabs' });
  const countEl = h('div', { class: 'pick-count' });
  const submit = h('button', { class: 'btn primary', disabled: true }) as HTMLButtonElement;

  const key = (p: string) => p.toLowerCase();
  const toggle = (f: FolderInfo) => {
    if (f.added) return;
    selected.has(key(f.path)) ? selected.delete(key(f.path)) : selected.set(key(f.path), f);
    render();
  };

  const row = (f: FolderInfo, opts: { navigable?: boolean } = {}) => {
    const on = selected.has(key(f.path));
    const el = h(
      'div',
      { class: `pick-row ${on ? 'on' : ''} ${f.added ? 'added' : ''}`, onclick: () => toggle(f), title: f.path },
      h('span', { class: 'check' }, on || f.added ? icon('check', 12) : null),
      h('span', { class: 'pick-ic', style: `--c:${f.kind ? KIND_COLOR[f.kind] ?? 'var(--violet)' : 'var(--fg-3)'}` }, icon(f.kind ? 'project' : 'filesystem', 16)),
      h('span', { class: 'pick-text' }, h('b', { html: filter && tab === 'discover' ? fuzzy(filter, f.name)?.html ?? f.name : escapeHtml(f.name) }), h('small', null, f.path)),
      f.added ? h('span', { class: 'badge', style: '--c:var(--green)' }, 'collegato') : f.kind ? h('span', { class: 'badge', style: `--c:${KIND_COLOR[f.kind] ?? 'var(--violet)'}` }, f.kind) : null,
      opts.navigable
        ? h(
            'button',
            {
              class: 'btn sq ghost enter',
              title: 'Apri cartella',
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                loadBrowse(f.path);
              },
            },
            icon('chevronRight', 16),
          )
        : null,
    );
    return el;
  };

  function renderDiscover(): HTMLElement {
    if (!discovered && !discoverError)
      return h('div', { class: 'pick-scan' }, h('div', { class: 'radar' }, icon('radar', 34)), h('b', null, 'Cerco i tuoi progetti…'), h('span', null, 'Desktop, Documenti, source/repos, Unity/Unreal Projects, altri dischi…'));
    if (discoverError) return h('div', { class: 'empty' }, discoverError);
    const list = discovered!.filter((f) => !filter || fuzzy(filter, f.name) || f.path.toLowerCase().includes(filter.toLowerCase()));
    const selectable = list.filter((f) => !f.added);
    const allOn = selectable.length > 0 && selectable.every((f) => selected.has(key(f.path)));
    const search = h('input', { class: 'input', placeholder: `Filtra ${discovered!.length} progetti trovati…`, value: filter, spellcheck: false }) as HTMLInputElement;
    search.addEventListener('input', () => {
      filter = search.value;
      const pos = search.selectionStart;
      render();
      const again = body.querySelector<HTMLInputElement>('.pick-tools input');
      again?.focus();
      again?.setSelectionRange(pos, pos);
    });
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'pick-tools' },
        h('div', { class: 'input-wrap', style: 'flex:1' }, icon('search', 15), search),
        h(
          'button',
          {
            class: 'btn',
            disabled: !selectable.length,
            onclick: () => {
              for (const f of selectable) allOn ? selected.delete(key(f.path)) : selected.set(key(f.path), f);
              render();
            },
          },
          icon(allOn ? 'x' : 'check', 14),
          allOn ? 'Deseleziona' : 'Seleziona tutti',
        ),
      ),
      list.length
        ? h('div', { class: 'pick-list scroll' }, ...list.map((f) => row(f)))
        : h('div', { class: 'empty' }, discovered!.length ? 'Nessun progetto corrisponde al filtro.' : 'Non ho trovato progetti nelle cartelle più comuni. Usa “Sfoglia” per sceglierli a mano.'),
    );
  }

  function renderBrowse(): HTMLElement {
    if (!browseState && !browseError) return h('div', { class: 'pick-scan' }, h('div', { class: 'spinner' }));
    const st = browseState;
    const pathInput = h('input', { class: 'input mono', value: st?.path ?? '', spellcheck: false, placeholder: 'Incolla un percorso e premi Invio' }) as HTMLInputElement;
    pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && loadBrowse(pathInput.value.trim()));
    const current: FolderInfo | undefined = st ? { path: st.path, name: st.path.split(/[\\/]/).filter(Boolean).pop() ?? st.path, kind: undefined } : undefined;
    return h(
      'div',
      null,
      h('div', { class: 'roots' }, ...(st?.roots ?? []).map((r) => h('button', { class: `chip ${st?.path === r.path ? 'on' : ''}`, onclick: () => loadBrowse(r.path) }, icon(r.name === 'Home' ? 'home' : 'drive', 13), r.name))),
      h(
        'div',
        { class: 'pick-tools' },
        h('button', { class: 'btn sq', title: 'Cartella superiore', disabled: !st?.parent, onclick: () => st?.parent && loadBrowse(st.parent) }, icon('arrowLeft', 15)),
        h('div', { class: 'input-wrap', style: 'flex:1' }, icon('folderOpen', 15), pathInput),
        current ? h('button', { class: `btn ${selected.has(key(current.path)) ? 'primary' : ''}`, title: 'Seleziona la cartella aperta', onclick: () => toggle(current) }, icon('check', 14), 'Questa') : null,
      ),
      browseError
        ? h('div', { class: 'empty' }, browseError)
        : st!.folders.length
          ? h('div', { class: 'pick-list scroll' }, ...st!.folders.map((f) => row(f, { navigable: true })))
          : h('div', { class: 'empty' }, 'Nessuna sottocartella qui.'),
    );
  }

  function renderFooter() {
    const n = selected.size;
    const names = [...selected.values()].map((f) => f.name);
    countEl.replaceChildren(
      n
        ? h('span', null, h('b', null, String(n)), n === 1 ? ' cartella selezionata' : ' cartelle selezionate', h('small', null, names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '')))
        : h('span', { class: 'faint' }, 'Seleziona una o più cartelle'),
    );
    submit.disabled = !n;
    submit.replaceChildren(icon('plus', 15), n > 1 ? `Collega ${n} progetti` : 'Collega progetto');
  }

  function render() {
    const scrollEl = body.querySelector('.pick-list');
    const scroll = scrollEl?.scrollTop ?? 0;
    tabs.replaceChildren(
      h('button', { class: `tab ${tab === 'discover' ? 'on' : ''}`, onclick: () => ((tab = 'discover'), render()) }, icon('radar', 14), 'Trovati sul PC', discovered ? h('span', { class: 'tab-n' }, String(discovered.filter((f) => !f.added).length)) : null),
      h(
        'button',
        {
          class: `tab ${tab === 'browse' ? 'on' : ''}`,
          onclick: () => {
            tab = 'browse';
            if (!browseState) loadBrowse();
            render();
          },
        },
        icon('folderOpen', 14),
        'Sfoglia',
      ),
    );
    body.replaceChildren(tab === 'discover' ? renderDiscover() : renderBrowse());
    const list = body.querySelector('.pick-list');
    if (list) list.scrollTop = scroll;
    renderFooter();
  }

  async function loadBrowse(p?: string) {
    browseError = '';
    try {
      browseState = await api.browse(p);
    } catch (err: any) {
      browseError = err.message;
    }
    if (tab === 'browse') {
      render();
      body.querySelector('.pick-list')?.scrollTo({ top: 0 });
    }
  }

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const res = await api.bulkProjects([...selected.values()].map((f) => f.path));
      for (const f of res.failed) o.toast(`${f.path}: ${f.error}`, true);
      close();
      o.onDone(res.added, res.existing);
    } catch (err: any) {
      o.toast(err.message, true);
      submit.disabled = false;
    }
  });

  const close = modal({
    icon: 'folderPlus',
    title: 'Aggiungi progetti',
    subtitle: 'Scegli tutte le cartelle che vuoi nel tuo cervello',
    tabs,
    body,
    footer: [countEl, h('button', { class: 'btn', onclick: () => close() }, 'Annulla'), submit],
  });
  render();
  api
    .discover()
    .then((r) => {
      discovered = r.projects;
      // pre-select nothing: the user decides; but jump to browse if discovery found nothing
      render();
    })
    .catch((err) => {
      discoverError = err.message;
      render();
    });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
