import { api } from '../api';
import type { ApprovalPolicy, Project, Settings } from '../types';
import { h } from './dom';

function modal(title: string, body: HTMLElement, footer: HTMLElement[], onClose: () => void) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const backdrop = h(
    'div',
    { class: 'backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() },
    h('div', { class: 'modal glass' }, h('header', null, h('h2', null, title)), h('div', { class: 'body scroll' }, body), h('footer', null, ...footer)),
  );
  document.addEventListener('keydown', onKey);
  document.getElementById('ui')!.appendChild(backdrop);
  return close;
}

export function openAddProject(onAdded: (p: Project) => void, toast: (m: string, e?: boolean) => void) {
  const pathInput = h('input', { class: 'input mono', placeholder: 'C:\\Users\\tu\\Progetti\\MioGioco  oppure  ~/code/app', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const nameInput = h('input', { class: 'input', placeholder: 'Nome (opzionale)' }) as HTMLInputElement;
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
          d,
        ),
      ),
    );
  };
  pathInput.addEventListener('input', refresh);
  const submit = async () => {
    try {
      const p = await api.addProject(pathInput.value.replace(/[\\/]+$/, '') || pathInput.value, nameInput.value || undefined);
      close();
      onAdded(p);
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const body = h(
    'div',
    null,
    h('p', { class: 'muted', style: 'margin:0 0 14px;line-height:1.5;font-size:12.5px' }, 'Collega una cartella del tuo PC. L’agente potrà lavorare solo dentro questa cartella; il progetto diventa un cluster del cervello.'),
    h('div', { class: 'field' }, h('label', null, 'Cartella del progetto'), pathInput, suggest),
    h('div', { class: 'field' }, h('label', null, 'Nome'), nameInput),
  );
  const close = modal('Nuovo progetto', body, [h('button', { class: 'btn', onclick: () => close() }, 'Annulla'), h('button', { class: 'btn primary', onclick: submit }, 'Aggiungi')], () => {});
  setTimeout(() => pathInput.focus(), 50);
  refresh();
}

const POLICIES: { key: keyof Settings['approvals']; label: string; hint: string; options: ApprovalPolicy[] }[] = [
  { key: 'fileWrite', label: 'Modifica file', hint: 'sempre annullabile con “Annulla modifiche”', options: ['auto', 'ask'] },
  { key: 'fileDelete', label: 'Elimina file', hint: '', options: ['auto', 'ask'] },
  { key: 'shell', label: 'Comandi terminale', hint: '“rischiosi” = tutto tranne build/test/lettura', options: ['auto', 'ask-risky', 'ask'] },
  { key: 'tests', label: 'Esecuzione test', hint: '', options: ['auto', 'ask'] },
  { key: 'git', label: 'Git commit / branch', hint: 'il push non viene mai fatto in automatico', options: ['auto', 'ask'] },
  { key: 'network', label: 'Accesso web', hint: '', options: ['auto', 'ask'] },
];
const POLICY_LABEL: Record<ApprovalPolicy, string> = { auto: 'auto', ask: 'chiedi', 'ask-risky': 'solo rischiosi' };

export async function openSettings(opts: { theme: string; setTheme: (t: 'dark' | 'light') => void; onSaved: () => void; toast: (m: string, e?: boolean) => void }) {
  const [s, models] = await Promise.all([api.settings(), api.models().catch(() => ({ models: [] as string[] }))]);
  const draft = structuredClone(s);
  const providerSel = h('select', { class: 'input' }, ...Object.entries(s.llm.providers).map(([id, p]) => h('option', { value: id, selected: id === s.llm.active }, `${id}  ·  ${p.type} @ ${p.baseUrl}`))) as HTMLSelectElement;
  const modelInput = h('input', { class: 'input mono', list: 'model-list', value: s.llm.providers[s.llm.active].model }) as HTMLInputElement;
  const ctxInput = h('input', { class: 'input', type: 'number', min: '2048', step: '1024', value: String(s.llm.providers[s.llm.active].contextTokens ?? 8192) }) as HTMLInputElement;
  const list = h('datalist', { id: 'model-list' }, ...models.models.map((m) => h('option', { value: m })));
  providerSel.addEventListener('change', () => {
    const p = s.llm.providers[providerSel.value];
    modelInput.value = p.model;
    ctxInput.value = String(p.contextTokens ?? 8192);
  });

  const seg = (value: string, options: string[], labels: Record<string, string>, onChange: (v: string) => void) => {
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
  };

  const steps = h('input', { class: 'input', type: 'number', min: '5', max: '200', value: String(s.agent.maxSteps), style: 'width:90px' }) as HTMLInputElement;
  const verify = h('input', { type: 'checkbox', checked: s.agent.requireVerification }) as HTMLInputElement;

  const body = h(
    'div',
    null,
    h('div', { class: 'eyebrow', style: 'margin-top:4px' }, 'Modello locale'),
    h('div', { class: 'field' }, h('label', null, 'Provider'), providerSel),
    h('div', { class: 'field' }, h('label', null, `Modello ${models.models.length ? `(${models.models.length} installati)` : ''}`), modelInput, list),
    h('div', { class: 'field' }, h('label', null, 'Finestra di contesto (token) — più alta = più RAM/VRAM'), ctxInput),
    h('div', { class: 'eyebrow' }, 'Autonomia'),
    ...POLICIES.map((p) =>
      h('div', { class: 'policy' }, h('div', null, p.label, p.hint ? h('small', null, p.hint) : null), seg(draft.approvals[p.key], p.options, POLICY_LABEL, (v) => (draft.approvals[p.key] = v as ApprovalPolicy))),
    ),
    h('div', { class: 'policy' }, h('div', null, 'Passi massimi per esecuzione'), steps),
    h('div', { class: 'policy' }, h('div', null, 'Obbliga la verifica dopo le modifiche', h('small', null, 'se l’agente modifica file senza testare, gli viene chiesto di farlo')), verify),
    h('div', { class: 'eyebrow' }, 'Aspetto'),
    h('div', { class: 'policy' }, h('div', null, 'Tema'), seg(opts.theme, ['dark', 'light'], { dark: 'scuro', light: 'chiaro' }, (v) => opts.setTheme(v as 'dark' | 'light'))),
  );

  const save = async () => {
    try {
      await api.saveSettings({
        llm: { active: providerSel.value, providers: { [providerSel.value]: { model: modelInput.value.trim(), contextTokens: Number(ctxInput.value) } } },
        approvals: draft.approvals,
        agent: { maxSteps: Number(steps.value), requireVerification: verify.checked },
      });
      close();
      opts.onSaved();
      opts.toast('Impostazioni salvate');
    } catch (err: any) {
      opts.toast(err.message, true);
    }
  };
  const close = modal('Impostazioni', body, [h('button', { class: 'btn', onclick: () => close() }, 'Chiudi'), h('button', { class: 'btn primary', onclick: save }, 'Salva')], () => {});
}
