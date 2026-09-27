import { api } from '../api';
import { prefs, savePrefs, type Quality } from '../prefs';
import type { ApprovalPolicy, Project, Settings, SystemInfo } from '../types';
import { h } from './dom';
import { icon } from './icons';

export type PullListener = (e: { model: string; status: string; completed?: number; total?: number; done?: boolean; error?: string }) => void;

export function modal(opts: { icon: string; title: string; subtitle?: string; body: HTMLElement; footer: HTMLElement[]; tabs?: HTMLElement; onClose?: () => void }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const backdrop = h(
    'div',
    { class: 'backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() },
    h(
      'div',
      { class: 'modal glass' },
      h('div', { class: 'm-head' }, h('div', { class: 'hero-icon', style: '--c:var(--violet)' }, icon(opts.icon, 20)), h('div', null, h('h2', null, opts.title), opts.subtitle ? h('p', null, opts.subtitle) : null)),
      opts.tabs ?? null,
      h('div', { class: 'm-body scroll' }, opts.body),
      h('div', { class: 'm-foot' }, ...opts.footer),
    ),
  );
  document.addEventListener('keydown', onKey, true);
  document.getElementById('ui')!.appendChild(backdrop);
  return close;
}

export function openAddProject(onAdded: (p: Project) => void, toast: (m: string, e?: boolean) => void) {
  const pathInput = h('input', { class: 'input mono', placeholder: 'C:\\Users\\tu\\Progetti\\MioGioco', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const nameInput = h('input', { class: 'input', placeholder: 'Opzionale — di default il nome della cartella' }) as HTMLInputElement;
  const suggest = h('div', { class: 'suggest' });
  let seq = 0;
  const refresh = async () => {
    const my = ++seq;
    const { dirs } = await api.dirs(pathInput.value).catch(() => ({ dirs: [] as string[] }));
    if (my !== seq) return;
    suggest.replaceChildren(
      ...dirs.map((d) =>
        h(
          'button',
          {
            onclick: () => {
              pathInput.value = d + (d.includes('\\') ? '\\' : '/');
              pathInput.focus();
              refresh();
            },
          },
          icon('filesystem', 14),
          d,
        ),
      ),
    );
  };
  pathInput.addEventListener('input', refresh);
  const submit = async () => {
    const value = pathInput.value.trim();
    if (!value) return pathInput.focus();
    try {
      const p = await api.addProject(value.replace(/[\\/]+$/, '') || value, nameInput.value.trim() || undefined);
      close();
      onAdded(p);
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const body = h(
    'div',
    null,
    h('div', { class: 'callout' }, icon('shield', 15), h('span', null, 'L’agente potrà leggere e modificare ', h('b', null, 'solo dentro questa cartella'), '. Ogni modifica è annullabile. Il progetto diventa un cluster di neuroni nel cervello.')),
    h('div', { class: 'field' }, h('label', null, 'Cartella del progetto', h('small', null, 'scrivi o scegli dai suggerimenti')), h('div', { class: 'input-wrap' }, icon('folderOpen', 16), pathInput), suggest),
    h('div', { class: 'field' }, h('label', null, 'Nome'), nameInput),
  );
  const close = modal({
    icon: 'project',
    title: 'Collega un progetto',
    subtitle: 'Una cartella del tuo PC su cui l’agente può lavorare',
    body,
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Annulla'), h('button', { class: 'btn primary', onclick: submit }, icon('plus', 15), 'Collega')],
  });
  setTimeout(() => pathInput.focus(), 60);
  refresh();
}

const POLICIES: { key: keyof Settings['approvals']; label: string; hint: string; options: ApprovalPolicy[] }[] = [
  { key: 'fileWrite', label: 'Modifica file', hint: 'Sempre annullabile con “Annulla modifiche”', options: ['auto', 'ask'] },
  { key: 'fileDelete', label: 'Elimina file', hint: 'Anche questo è annullabile', options: ['auto', 'ask'] },
  { key: 'shell', label: 'Comandi terminale', hint: '“Rischiosi” = tutto tranne build, test e lettura', options: ['auto', 'ask-risky', 'ask'] },
  { key: 'tests', label: 'Esecuzione test', hint: '', options: ['auto', 'ask'] },
  { key: 'git', label: 'Git commit e branch', hint: 'Il push non viene mai fatto automaticamente', options: ['auto', 'ask'] },
  { key: 'network', label: 'Accesso al web', hint: 'Ricerca e lettura di pagine', options: ['auto', 'ask'] },
];
const POLICY_LABEL: Record<string, string> = { auto: 'Automatico', ask: 'Chiedi', 'ask-risky': 'Solo rischiosi' };

function seg(value: string, options: string[], labels: Record<string, string>, onChange: (v: string) => void) {
  const el = h('div', { class: 'seg' });
  const draw = (v: string) =>
    el.replaceChildren(
      ...options.map((o) =>
        h(
          'button',
          {
            class: o === v ? 'on' : '',
            onclick: () => {
              onChange(o);
              draw(o);
            },
          },
          labels[o] ?? o,
        ),
      ),
    );
  draw(value);
  return el;
}

function toggle(on: boolean, onChange: (v: boolean) => void) {
  const b = h('button', { class: `switch ${on ? 'on' : ''}`, role: 'switch' }) as HTMLButtonElement;
  b.addEventListener('click', () => {
    on = !on;
    b.classList.toggle('on', on);
    onChange(on);
  });
  return b;
}

const fmtGB = (b?: number) => (b ? `${(b / 2 ** 30).toFixed(1)} GB` : '');

export interface SettingsOptions {
  setTheme(t: 'dark' | 'light'): void;
  setAutoRotate(on: boolean): void;
  setReducedMotion(on: boolean): void;
  onSaved(): void;
  toast(m: string, e?: boolean): void;
  subscribePull(fn: PullListener): () => void;
  tab?: 'model' | 'autonomy' | 'look' | 'system';
}

export async function openSettings(o: SettingsOptions) {
  const [s, modelsRes, sys] = await Promise.all([api.settings(), api.models().catch(() => ({ models: [] as string[] })), api.system().catch(() => undefined as SystemInfo | undefined)]);
  const draft = structuredClone(s);
  let provider = s.llm.active;
  let model = s.llm.providers[provider].model;
  let ctx = s.llm.providers[provider].contextTokens ?? 8192;
  const installed = new Set(modelsRes.models);
  const pulls = new Map<string, { pct: number; status: string }>();

  // ── Modello ──
  const modelPane = h('div', { class: 'pane' });
  const drawModels = () => {
    const rec = sys?.recommendation;
    const wanted = [...new Set([model, ...(rec ? [rec.main, rec.fast].filter(Boolean) : []), ...installed])] as string[];
    const custom = h('input', { class: 'input mono', placeholder: 'es. qwen3:14b, gpt-oss:20b, llama3.1:8b…', spellcheck: false }) as HTMLInputElement;
    const pull = (name: string) => {
      api.pullModel(name).catch((err) => o.toast(err.message, true));
      pulls.set(name, { pct: 0, status: 'avvio…' });
      drawModels();
    };
    const ctxLabel = h('small', null, `${(ctx / 1024).toFixed(0)}K token`);
    const range = h('input', { type: 'range', class: 'range', min: '4096', max: '65536', step: '4096', value: String(ctx) }) as HTMLInputElement;
    range.addEventListener('input', () => {
      ctx = Number(range.value);
      ctxLabel.textContent = `${(ctx / 1024).toFixed(0)}K token`;
    });
    const providerSel = h('select', { class: 'input' }, ...Object.entries(s.llm.providers).map(([id, p]) => h('option', { value: id, selected: id === provider }, `${id} — ${p.type === 'ollama' ? 'Ollama' : 'OpenAI‑compatibile'} · ${p.baseUrl}`))) as HTMLSelectElement;
    providerSel.addEventListener('change', () => {
      provider = providerSel.value;
      model = s.llm.providers[provider].model;
      ctx = s.llm.providers[provider].contextTokens ?? 8192;
      drawModels();
    });
    modelPane.replaceChildren(
      ...(rec ? [h('div', { class: 'callout' }, icon('sparkles', 15), h('span', null, 'Consigliato per il tuo PC: ', h('b', null, rec.main), rec.fast ? [' + ', h('b', null, rec.fast), ' (veloce)'] : '', `. ${rec.reason}.`))] : []),
      h('div', { class: 'field' }, h('label', null, 'Motore'), providerSel),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Modello', h('small', null, installed.size ? `${installed.size} installati` : 'nessun modello trovato')),
        h(
          'div',
          { class: 'models' },
          ...wanted.map((name) => {
            const has = installed.has(name) || installed.has(`${name}:latest`);
            const p = pulls.get(name);
            return h(
              'button',
              {
                class: `model-card ${name === model ? 'on' : ''}`,
                onclick: () => {
                  model = name;
                  drawModels();
                },
              },
              h('span', { class: 'radio' }),
              h('span', { class: 'name' }, name),
              name === rec?.main ? h('span', { class: 'badge', style: '--c:var(--violet)' }, 'consigliato') : name === rec?.fast ? h('span', { class: 'badge', style: '--c:var(--cyan)' }, 'veloce') : null,
              p ? h('span', { class: 'prog', title: p.status }, h('i', { style: `width:${p.pct}%` })) : has ? h('span', { class: 'badge', style: '--c:var(--green)' }, icon('check', 10), 'installato') : h('span', { class: 'btn', style: 'height:28px', onclick: (e: MouseEvent) => (e.stopPropagation(), pull(name)) }, icon('download', 13), 'Scarica'),
            );
          }),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Altro modello'),
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'input-wrap', style: 'flex:1' }, icon('cpu', 15), custom),
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                const name = custom.value.trim();
                if (!name) return custom.focus();
                model = name;
                if (!installed.has(name)) pull(name);
                else drawModels();
              },
            },
            icon('download', 14),
            'Usa / scarica',
          ),
        ),
      ),
      h('div', { class: 'field' }, h('label', null, 'Finestra di contesto', ctxLabel), range, h('small', { class: 'faint', style: 'font-size:11.5px' }, 'Più contesto = l’agente “vede” più codice insieme, ma usa più RAM/VRAM ed è più lento.')),
    );
  };
  drawModels();
  const unsub = o.subscribePull((e) => {
    if (e.done) {
      pulls.delete(e.model);
      if (!e.error) {
        installed.add(e.model);
        o.toast(`${e.model} scaricato`);
      } else o.toast(`${e.model}: ${e.error}`, true);
    } else pulls.set(e.model, { pct: e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : 0, status: e.status });
    drawModels();
  });

  // ── Autonomia ──
  const steps = h('input', { class: 'input', type: 'number', min: '5', max: '200', value: String(s.agent.maxSteps), style: 'width:90px' }) as HTMLInputElement;
  let verify = s.agent.requireVerification;
  const autonomyPane = h(
    'div',
    { class: 'pane' },
    h('div', { class: 'callout' }, icon('shield', 15), h('span', null, 'Le azioni ', h('b', null, 'distruttive'), ' (rm -rf, git push, reset --hard…) chiedono ', h('b', null, 'sempre'), ' conferma, qualunque sia l’impostazione.')),
    ...POLICIES.map((p) => h('div', { class: 'policy' }, h('div', null, p.label, p.hint ? h('small', null, p.hint) : null), seg(draft.approvals[p.key], p.options, POLICY_LABEL, (v) => (draft.approvals[p.key] = v as ApprovalPolicy)))),
    h('div', { class: 'policy' }, h('div', null, 'Passi massimi per esecuzione', h('small', null, 'Limite di sicurezza per task molto lunghi')), steps),
    h('div', { class: 'policy' }, h('div', null, 'Verifica obbligatoria', h('small', null, 'Se modifica file senza testarli, l’agente deve farlo prima di chiudere')), toggle(verify, (v) => (verify = v))),
  );

  // ── Aspetto ──
  const qualityNote = h('small', { class: 'faint' });
  const lookPane = h(
    'div',
    { class: 'pane' },
    h('div', { class: 'policy' }, h('div', null, 'Tema'), seg(prefs.theme, ['dark', 'light'], { dark: 'Scuro', light: 'Chiaro' }, (v) => o.setTheme(v as 'dark' | 'light'))),
    h(
      'div',
      { class: 'policy' },
      h('div', null, 'Qualità grafica', h('small', null, 'Numero di neuroni, risoluzione ed effetti'), qualityNote),
      seg(prefs.quality, ['high', 'medium', 'low'], { high: 'Alta', medium: 'Media', low: 'Bassa' }, (v) => {
        savePrefs({ quality: v as Quality });
        qualityNote.replaceChildren(' ', h('a', { href: '#', style: 'color:var(--violet)', onclick: (e: Event) => (e.preventDefault(), location.reload()) }, 'Ricarica per applicare'));
      }),
    ),
    h('div', { class: 'policy' }, h('div', null, 'Rotazione automatica', h('small', null, 'Il cervello ruota lentamente quando non lo tocchi')), toggle(prefs.autoRotate, (v) => (savePrefs({ autoRotate: v }), o.setAutoRotate(v)))),
    h('div', { class: 'policy' }, h('div', null, 'Animazioni ridotte', h('small', null, 'Meno movimento nell’interfaccia')), toggle(prefs.reducedMotion, (v) => (savePrefs({ reducedMotion: v }), o.setReducedMotion(v)))),
    h('div', { class: 'policy' }, h('div', null, 'Intro all’avvio', h('small', null, 'La sequenza in cui il cervello si assembla')), toggle(prefs.intro, (v) => savePrefs({ intro: v }))),
  );

  // ── Sistema ──
  const systemPane = h(
    'div',
    { class: 'pane' },
    sys
      ? h(
          'div',
          null,
          h(
            'div',
            { class: 'sys' },
            h('div', { class: 'stat' }, h('div', { class: 'v' }, sys.cpu), h('div', { class: 'k' }, `CPU · ${sys.cores} thread`)),
            h('div', { class: 'stat' }, h('div', { class: 'v' }, `${sys.ramGB} GB`), h('div', { class: 'k' }, 'RAM')),
            ...(sys.gpus.length ? sys.gpus.map((g) => h('div', { class: 'stat', style: 'grid-column:1/-1' }, h('div', { class: 'v' }, g.name), h('div', { class: 'k' }, g.vramGB ? `GPU · ${g.vramGB} GB VRAM` : 'GPU'))) : [h('div', { class: 'stat', style: 'grid-column:1/-1' }, h('div', { class: 'v' }, 'Nessuna GPU rilevata'), h('div', { class: 'k' }, 'il modello girerà su CPU'))]),
          ),
          h('div', { class: 'callout', style: 'margin-top:14px' }, icon('sparkles', 15), h('span', null, h('b', null, 'Setup automatico: '), 'rilancia ', h('code', { class: 'mono' }, 'AI-Brain.bat'), ' con ', h('code', { class: 'mono' }, '--reconfigure'), ' per ricalcolare i modelli ideali e riscaricarli.')),
        )
      : h('div', { class: 'empty' }, 'Informazioni di sistema non disponibili'),
  );

  const panes = { model: modelPane, autonomy: autonomyPane, look: lookPane, system: systemPane };
  const body = h('div');
  const tabs = h('div', { class: 'tabs' });
  const TABS: [keyof typeof panes, string, string][] = [
    ['model', 'cpu', 'Modello'],
    ['autonomy', 'shield', 'Autonomia'],
    ['look', 'sparkles', 'Aspetto'],
    ['system', 'gauge', 'Sistema'],
  ];
  const select = (k: keyof typeof panes) => {
    tabs.replaceChildren(...TABS.map(([key, ic, label]) => h('button', { class: `tab ${key === k ? 'on' : ''}`, onclick: () => select(key) }, icon(ic, 14), label)));
    body.replaceChildren(panes[k]);
  };
  select(o.tab ?? 'model');

  const save = async () => {
    try {
      await api.saveSettings({
        llm: { active: provider, providers: { [provider]: { model: model.trim(), contextTokens: ctx } } },
        approvals: draft.approvals,
        agent: { maxSteps: Number(steps.value), requireVerification: verify },
      });
      close();
      o.onSaved();
      o.toast('Impostazioni salvate');
    } catch (err: any) {
      o.toast(err.message, true);
    }
  };
  const close = modal({
    icon: 'settings',
    title: 'Impostazioni',
    subtitle: 'Modello, autonomia dell’agente e aspetto',
    tabs,
    body,
    footer: [h('span', { class: 'faint', style: 'margin-right:auto;font-size:11.5px' }, 'Tutto resta sul tuo PC'), h('button', { class: 'btn', onclick: () => close() }, 'Chiudi'), h('button', { class: 'btn primary', onclick: save }, icon('check', 15), 'Salva')],
    onClose: unsub,
  });
}
