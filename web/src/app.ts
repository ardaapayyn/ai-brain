import * as THREE from 'three';
import { api, connectEvents } from './api';
import { palette } from './scene/palette';
import { BrainScene } from './scene/brain';
import { applyEvent, newRun, state, type RunView } from './state';
import type { BrainEvent, Graph } from './types';
import { ActivityPanel, approvalButtons } from './ui/activity';
import { DetailPanel } from './ui/detail';
import { h } from './ui/dom';
import { openAddProject, openSettings } from './ui/modals';

const CATEGORY_COLOR: Record<string, number> = {
  filesystem: 0x60a5fa,
  search: 0x67e8f9,
  terminal: 0xfde047,
  git: 0xfb923c,
  tests: 0x4ade80,
  web: 0xc4b5fd,
  memory: 0xfbbf24,
  planning: 0xf472b6,
};

export class App {
  private scene: BrainScene;
  private ui = document.getElementById('ui')!;
  private activity: ActivityPanel;
  private detail: DetailPanel;
  private ws!: ReturnType<typeof connectEvents>;
  private statusPill = h('div', { class: 'status-pill glass' });
  private banner = h('div', { class: 'banner glass' });
  private toasts = h('div', { class: 'toasts' });
  private command = h('div', { class: 'command glass' });
  private textarea = h('textarea', { rows: 1, placeholder: 'Chiedi al tuo cervello…  es. «Analizza il mio progetto e sistema il combat system»' }) as HTMLTextAreaElement;
  private ctxRow = h('div', { class: 'ctx' });
  private sendBtn = h('button', { class: 'send', title: 'Invia (Enter)' }, '↑') as HTMLButtonElement;
  private floatApproval = h('div', { class: 'approval-float glass' });
  private welcome = h('div', { class: 'welcome glass' });
  private hint = h('div', { class: 'hint' }, 'trascina per ruotare · scroll per zoom · click su un nodo per entrare · doppio click per tornare · / per scrivere');
  private graphTimer?: number;
  private lastTokenPulse = 0;

  constructor() {
    document.body.classList.toggle('light', state.theme === 'light');
    this.scene = new BrainScene(document.getElementById('scene') as HTMLCanvasElement, document.getElementById('labels')!, state.theme);
    this.activity = new ActivityPanel({
      close: () => this.activity.hide(),
      cancel: (id) => api.cancelRun(id).catch((e) => this.toast(e.message, true)),
      revert: (id) => this.revert(id),
      approve: (id, ok, scope) => this.approve(id, ok, scope),
      followUp: (taskId) => {
        const run = [...state.runs.values()].find((r) => r.taskId === taskId);
        this.setFollow(taskId, run?.prompt ?? 'task');
      },
    });
    this.detail = new DetailPanel({
      close: () => this.deselect(),
      focusNode: (id) => this.selectNode(id, true),
      useProject: (id) => this.setProject(id),
      followUp: (id, title) => this.setFollow(id, title),
      openRun: (id) => this.openRun(id),
      toast: (m, e) => this.toast(m, e),
      refresh: () => this.loadGraph(),
      confirm: (m) => window.confirm(m),
    });
    this.buildChrome();
    this.scene.onSelect = (id) => (id ? this.selectNode(id, false) : this.deselect());
    this.bindKeys();

    this.ws = connectEvents(
      (e) => this.onEvent(e),
      (up) => {
        state.connected = up;
        if (up) {
          this.loadStatus();
          this.loadGraph();
        }
        this.renderStatus();
      },
    );
    setInterval(() => this.loadStatus(), 15000);
    setTimeout(() => (this.hint.style.opacity = '0'), 12000);
  }

  // ── chrome ──────────────────────────────────────────────────
  private buildChrome() {
    const hudLeft = h('div', { class: 'hud-left' }, h('div', { class: 'brand' }, 'AI', h('b', null, ' · '), 'BRAIN'), this.statusPill);
    this.statusPill.addEventListener('click', () => this.openSettings());
    const hudRight = h(
      'div',
      { class: 'hud-right' },
      h('button', { class: 'btn icon', title: 'Vista d’insieme (doppio click)', onclick: () => (this.deselect(), this.scene.home()) }, '◎'),
      h('button', { class: 'btn', title: 'Collega una cartella progetto', onclick: () => this.addProject() }, '+ Progetto'),
      h('button', { class: 'btn icon', title: 'Tema chiaro/scuro (T)', onclick: () => this.toggleTheme() }, '◐'),
      h('button', { class: 'btn icon', title: 'Impostazioni', onclick: () => this.openSettings() }, '⚙'),
    );
    this.banner.style.display = 'none';
    this.floatApproval.style.display = 'none';
    this.welcome.style.display = 'none';

    this.textarea.addEventListener('input', () => this.autosize());
    this.textarea.addEventListener('focus', () => this.command.classList.add('focus'));
    this.textarea.addEventListener('blur', () => this.command.classList.remove('focus'));
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.sendBtn.addEventListener('click', () => this.submit());
    this.command.append(this.ctxRow, h('div', { class: 'input-row' }, this.textarea, this.sendBtn));
    this.ui.append(hudLeft, hudRight, this.banner, this.detail.el, this.activity.el, this.welcome, this.floatApproval, this.command, this.hint, this.toasts);
    this.renderContext();
    this.renderStatus();
  }

  private autosize() {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = Math.min(this.textarea.scrollHeight, 180) + 'px';
  }

  private bindKeys() {
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === 'Escape') {
        if (typing) (e.target as HTMLElement).blur();
        else if (this.detail.nodeId) this.deselect();
        else if (this.activity.visibleRunId) this.activity.hide();
        else this.scene.home();
      } else if (!typing && e.key === '/') {
        e.preventDefault();
        this.textarea.focus();
      } else if (!typing && (e.key === 't' || e.key === 'T')) {
        this.toggleTheme();
      }
    });
  }

  private toggleTheme() {
    this.setTheme(state.theme === 'dark' ? 'light' : 'dark');
  }
  private setTheme(t: 'dark' | 'light') {
    state.theme = t;
    try {
      localStorage.setItem('brain.theme', t);
    } catch {
      /* ignore */
    }
    document.body.classList.toggle('light', t === 'light');
    this.scene.setTheme(t);
  }

  private openSettings() {
    openSettings({ theme: state.theme, setTheme: (t) => this.setTheme(t), onSaved: () => this.loadStatus(), toast: (m, e) => this.toast(m, e) }).catch((e) => this.toast(e.message, true));
  }

  private addProject() {
    openAddProject(
      async (p) => {
        this.toast(`Progetto “${p.name}” collegato — indicizzazione in corso`);
        this.setProject(p.id);
        await this.loadGraph();
        setTimeout(() => this.selectNode(p.id, true), 400);
      },
      (m, e) => this.toast(m, e),
    );
  }

  toast(msg: string, error = false) {
    const t = h('div', { class: `toast glass ${error ? 'error' : ''}` }, msg);
    this.toasts.append(t);
    setTimeout(() => t.remove(), error ? 7000 : 3500);
  }

  // ── data ────────────────────────────────────────────────────
  private async loadStatus() {
    try {
      state.status = await api.status();
      for (const a of state.status.pendingApprovals) this.showFloatingApproval(a);
    } catch {
      state.status = undefined;
    }
    this.renderStatus();
  }

  private renderStatus() {
    const s = state.status;
    const busy = [...state.runs.values()].some((r) => r.status === 'running');
    const dotClass = !state.connected ? 'bad' : busy ? 'busy' : s?.llm.ok ? 'ok' : 'bad';
    const label = !state.connected ? 'server offline' : s ? `${s.model}${busy ? ' · al lavoro' : s.llm.ok ? '' : ' · non pronto'}` : '…';
    this.statusPill.replaceChildren(h('span', { class: `dot ${dotClass}` }), h('span', { class: 'mono' }, label));
    if (!state.connected) {
      this.banner.replaceChildren('Server non raggiungibile. Avvialo con ', h('code', null, 'npm run dev'), ' nella cartella di AI Brain.');
      this.banner.style.display = '';
    } else if (s && !s.llm.ok) {
      const pull = /ollama pull (\S+)/.exec(s.llm.detail);
      this.banner.replaceChildren('⚠ ', pull ? h('span', null, 'Modello non scaricato. Esegui ', h('code', null, `ollama pull ${pull[1]}`), ' oppure scegline un altro nelle impostazioni.') : s.llm.detail);
      this.banner.style.display = '';
    } else this.banner.style.display = 'none';
  }

  private async loadGraph() {
    try {
      const [g, projects] = await Promise.all([api.graph(), api.projects()]);
      state.graph = g;
      state.projects = projects;
      if (state.projectId && !projects.some((p) => p.id === state.projectId)) state.projectId = null;
      if (!state.projectId && projects.length === 1) state.projectId = projects[0].id;
      this.scene.setGraph(g);
      this.updateActivePath(g);
      const shown = this.detail.nodeId && g.nodes.find((n) => n.id === this.detail.nodeId);
      if (shown && (shown.type === 'project' || shown.type === 'task') && !document.activeElement?.closest('.panel.left')) this.detail.show(shown, true);
      this.renderContext();
      this.renderWelcome();
    } catch {
      /* offline: banner already shown */
    }
  }

  private scheduleGraph() {
    clearTimeout(this.graphTimer);
    this.graphTimer = window.setTimeout(() => this.loadGraph(), 180);
  }

  private updateActivePath(g: Graph) {
    const run = g.activeRuns[0];
    this.scene.graph.setActivePath(run ? ['core', ...(run.projectId ? [run.projectId] : []), run.taskId] : []);
  }

  private renderWelcome() {
    const show = state.connected && state.projects.length === 0 && !this.activity.visibleRunId;
    this.welcome.style.display = show ? '' : 'none';
    if (show)
      this.welcome.replaceChildren(
        h('h3', null, 'Benvenuto nel tuo cervello digitale'),
        h('p', null, 'Collega la cartella di un progetto: diventerà un cluster di neuroni. Poi chiedi all’agente di analizzarlo, correggerlo o estenderlo — tutto in locale.'),
        h('button', { class: 'btn primary', onclick: () => this.addProject() }, '+ Collega un progetto'),
      );
  }

  // ── context (where prompts go) ──────────────────────────────
  private setProject(id: string | null) {
    state.projectId = id;
    state.followTaskId = undefined;
    this.renderContext();
    this.textarea.focus();
  }

  private setFollow(taskId: string, title: string) {
    const run = [...state.runs.values()].find((r) => r.taskId === taskId);
    const node = state.graph?.nodes.find((n) => n.id === taskId);
    state.followTaskId = taskId;
    state.followTaskTitle = node?.label ?? title;
    const projectId = run?.projectId ?? (node?.parent && node.parent !== 'core' ? node.parent : null);
    if (projectId !== undefined) state.projectId = projectId;
    this.renderContext();
    this.textarea.focus();
  }

  private renderContext() {
    const project = state.projects.find((p) => p.id === state.projectId);
    const projectChip = h('button', { class: 'chip', title: 'Scegli dove lavora l’agente' }, project ? `◈ ${project.name}` : '◌ nessun progetto (scratch)', ' ▾');
    projectChip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleProjectMenu(projectChip);
    });
    const chips: HTMLElement[] = [projectChip];
    if (state.followTaskId) {
      chips.push(
        h(
          'button',
          {
            class: 'chip',
            title: 'Il prossimo messaggio continua questo task (clic per annullare)',
            onclick: () => {
              state.followTaskId = undefined;
              this.renderContext();
            },
          },
          `↳ ${state.followTaskTitle}`,
          h('span', { class: 'x' }, '✕'),
        ),
      );
    }
    this.ctxRow.replaceChildren(...chips);
    const running = this.currentContextRun();
    this.command.classList.toggle('busy', !!running);
    this.sendBtn.classList.toggle('stop', !!running);
    this.sendBtn.textContent = running ? '■' : '↑';
    this.sendBtn.title = running ? 'Interrompi l’esecuzione' : 'Invia (Enter)';
  }

  private toggleProjectMenu(anchor: HTMLElement) {
    const existing = this.command.querySelector('.menu');
    if (existing) return existing.remove();
    const choose = (id: string | null) => {
      menu.remove();
      this.setProject(id);
      if (id) this.scene.flyTo(id);
    };
    const menu = h(
      'div',
      { class: 'menu glass scroll' },
      ...state.projects.map((p) => h('button', { class: p.id === state.projectId ? 'on' : '', onclick: () => choose(p.id) }, '◈ ', p.name)),
      h('button', { class: state.projectId === null ? 'on' : '', onclick: () => choose(null) }, '◌ nessun progetto (scratch)'),
      h('button', { onclick: () => (menu.remove(), this.addProject()) }, '+ collega un progetto…'),
    );
    this.command.append(menu);
    const off = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) {
        menu.remove();
        document.removeEventListener('mousedown', off);
      }
    };
    document.addEventListener('mousedown', off);
  }

  private currentContextRun(): RunView | undefined {
    return [...state.runs.values()].find((r) => r.status === 'running' && r.projectId === state.projectId);
  }

  private async submit() {
    const running = this.currentContextRun();
    if (running) {
      await api.cancelRun(running.runId).catch((e) => this.toast(e.message, true));
      return;
    }
    const prompt = this.textarea.value.trim();
    if (!prompt) return;
    this.sendBtn.disabled = true;
    try {
      await api.startRun(prompt, state.projectId, state.followTaskId);
      this.textarea.value = '';
      this.autosize();
      state.followTaskId = undefined;
      this.renderContext();
    } catch (err: any) {
      this.toast(err.message, true);
    } finally {
      this.sendBtn.disabled = false;
    }
  }

  // ── selection ───────────────────────────────────────────────
  private selectNode(id: string, fly: boolean) {
    const node = this.scene.graph.get(id)?.node ?? state.graph?.nodes.find((n) => n.id === id);
    if (!node) return;
    state.selectedNode = id;
    this.scene.graph.selected = id;
    if (fly) this.scene.flyTo(id);
    if (node.type === 'project') {
      state.projectId = id;
      this.renderContext();
    }
    this.detail.show(node);
    // entering a running task shows its live activity
    if (node.type === 'task') {
      const live = [...state.runs.values()].find((r) => r.taskId === id && r.status === 'running');
      if (live) this.activity.show(live);
    }
  }

  private deselect() {
    state.selectedNode = undefined;
    this.scene.graph.selected = undefined;
    this.detail.hide();
  }

  private async openRun(runId: string) {
    let run = state.runs.get(runId);
    if (!run) {
      const { run: rec, events } = await api.run(runId);
      const start = events.find((e) => e.type === 'run.started');
      if (!start || start.type !== 'run.started') return this.toast('Log non disponibile per questa esecuzione', true);
      run = newRun(start, rec.startedAt);
      for (const e of events) applyEvent(run, e);
      run.status = rec.status;
      run.endedAt = rec.endedAt;
      run.reverted = rec.reverted;
      run.model = rec.model;
      state.runs.set(runId, run);
    }
    this.activity.show(run);
  }

  private async revert(runId: string) {
    if (!window.confirm('Ripristinare tutti i file modificati da questa esecuzione allo stato precedente?')) return;
    try {
      const r = await api.revertRun(runId);
      const run = state.runs.get(runId);
      if (run) run.reverted = true;
      this.activity.invalidate();
      this.toast(`Ripristinati ${r.restored.length} file`);
    } catch (err: any) {
      this.toast(err.message, true);
    }
  }

  private approve(id: string, approved: boolean, scope: 'once' | 'run') {
    this.ws.send({ type: 'approval', id, approved, scope });
    api.approve(id, approved, scope).catch(() => {}); // HTTP fallback; duplicate resolve is a no-op
    this.floatApproval.style.display = 'none';
  }

  private showFloatingApproval(a: { id: string; tool: string; summary: string; detail: string; danger: boolean }) {
    // Visible even when the activity panel is closed.
    this.floatApproval.dataset.id = a.id;
    this.floatApproval.replaceChildren(
      h(
        'div',
        { class: `approval ${a.danger ? 'danger' : ''}`, style: 'border:none;background:none;padding:0' },
        h('div', { class: 'title' }, a.danger ? '⚠ L’agente vuole eseguire un’azione distruttiva' : '◆ L’agente chiede conferma', h('span', { class: 'mono faint' }, a.tool)),
        h('pre', null, a.detail || a.summary),
        approvalButtons(a.id, a.danger, (id, ok, scope) => this.approve(id, ok, scope)),
      ),
    );
    this.floatApproval.style.display = '';
  }

  // ── live events → UI + 3D choreography ─────────────────────
  private onEvent(e: BrainEvent) {
    const sc = this.scene;
    const pos = (id: string) => () => sc.graph.position(id);
    const pal = palette(state.theme);

    if (e.type === 'hello') {
      if (e.pendingApprovals[0]) this.showFloatingApproval(e.pendingApprovals[0]);
      sc.setActivity(e.activeRuns.length ? 0.6 : 0);
      return;
    }
    if (e.type === 'graph.changed') return this.scheduleGraph();
    if (e.type === 'memory.added') {
      sc.pulses.fire(pos('core'), pos('tool:memory'), { color: pal.memory.decision, size: 9 });
      return;
    }

    let run = 'runId' in e ? state.runs.get(e.runId) : undefined;
    if (e.type === 'run.started') {
      run = newRun(e);
      state.runs.set(e.runId, run);
      sc.setActivity(0.7);
      this.activity.show(run);
      this.welcome.style.display = 'none';
      this.renderContext();
      this.renderStatus();
      // wait for the new task node to exist in the graph, then fly to it
      this.loadGraph().then(() => {
        sc.pulses.chain([pos('core'), pos(e.projectId ?? 'core'), pos(e.taskId)], { color: pal.taskRunning, size: 11, duration: 0.7 });
        if (!state.selectedNode || state.selectedNode === e.projectId) sc.flyTo(e.taskId, 170);
      });
      return;
    }
    if (!run) return;
    applyEvent(run, e);
    if (this.activity.visibleRunId === run.runId) this.activity.invalidate();
    const taskPos = pos(run.taskId);
    const hub = run.projectId ?? 'core';

    switch (e.type) {
      case 'run.status':
        sc.setActivity(e.phase === 'waiting_approval' ? 0.35 : e.phase === 'tool' ? 0.95 : 0.8);
        break;
      case 'llm.token': {
        const now = performance.now();
        if (now - this.lastTokenPulse > 110) {
          this.lastTokenPulse = now;
          sc.spark();
          sc.bumpActivity(0.03);
          if (Math.random() < 0.35) sc.pulses.fire(pos('core'), taskPos, { color: pal.fieldB, size: 5, duration: 0.8 });
        }
        break;
      }
      case 'tool.started': {
        const color = CATEGORY_COLOR[e.category] ?? pal.pulse;
        sc.pulses.chain([pos('core'), pos(`tool:${e.category}`), pos(hub), taskPos], { color, size: 9, duration: 0.55 });
        sc.bumpActivity(0.2);
        break;
      }
      case 'tool.output':
        if (Math.random() < 0.15) sc.spark(CATEGORY_COLOR.terminal);
        break;
      case 'tool.finished': {
        const cat = run.items.find((i) => i.kind === 'tool' && i.callId === e.callId);
        const category = cat && cat.kind === 'tool' ? cat.category : 'planning';
        sc.pulses.fire(taskPos, pos(`tool:${category}`), { color: e.ok ? pal.ok : pal.fail, size: 8, duration: 0.7 });
        break;
      }
      case 'plan.updated':
        for (let i = 0; i < e.steps.length; i++) setTimeout(() => sc.pulses.fire(pos('tool:planning'), taskPos, { color: CATEGORY_COLOR.planning, size: 7 }), i * 90);
        break;
      case 'approval.requested':
        this.showFloatingApproval(e);
        sc.pulses.fire(taskPos, pos('core'), { color: pal.taskRunning, size: 14, duration: 1.2 });
        break;
      case 'approval.resolved':
        if (this.floatApproval.dataset.id === e.id) this.floatApproval.style.display = 'none';
        break;
      case 'run.finished': {
        sc.setActivity(0);
        const color = e.status === 'done' ? pal.ok : e.status === 'failed' ? pal.fail : pal.pulse;
        const origin = sc.graph.position(run.taskId)?.clone() ?? new THREE.Vector3();
        for (let i = 0; i < 18; i++) {
          const dir = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 60);
          sc.pulses.fire(origin, origin.clone().add(dir), { color, size: 8, duration: 0.9 + Math.random() * 0.6, arc: 0.1 });
        }
        if (this.floatApproval.style.display !== 'none') this.floatApproval.style.display = 'none';
        this.renderContext();
        this.renderStatus();
        if (e.status === 'failed') this.toast('Esecuzione terminata con errori — vedi il report', true);
        break;
      }
    }
  }
}
