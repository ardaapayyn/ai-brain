import * as THREE from 'three';
import { api, connectEvents } from './api';
import { prefs, savePrefs } from './prefs';
import { BrainScene } from './scene/brain';
import { palette } from './scene/palette';
import { applyEvent, newRun, state, type RunView } from './state';
import type { Approval, BrainEvent, Graph } from './types';
import { ActivityPanel, approvalButtons } from './ui/activity';
import { CommandBar } from './ui/command';
import { DetailPanel } from './ui/detail';
import { h } from './ui/dom';
import { Banner, HudRight, Legend, OfflineOverlay } from './ui/hud';
import { icon } from './ui/icons';
import { Intro } from './ui/intro';
import { openSettings, type PullListener, type SettingsOptions } from './ui/modals';
import { openProjectPicker } from './ui/projects';
import { CommandPalette } from './ui/palette';
import { mountToasts, toast } from './ui/toast';
import { NodeTooltip } from './ui/tooltip';
import { welcomeCard } from './ui/welcome';

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
  private ui = document.getElementById('ui')!;
  private scene: BrainScene;
  private hudRight: HudRight;
  private legend: Legend;
  private banner = new Banner();
  private offline = new OfflineOverlay();
  private command: CommandBar;
  private activity: ActivityPanel;
  private detail: DetailPanel;
  private tooltip = new NodeTooltip();
  private palette: CommandPalette;
  private floatApproval = h('div', { class: 'approval-float glass' });
  private floating?: Approval;
  private welcome?: HTMLElement;
  private welcomeDismissed = false;
  private ws!: ReturnType<typeof connectEvents>;
  private graphTimer?: number;
  private lastSpark = 0;
  private tokenTimes: number[] = [];
  private pullListeners = new Set<PullListener>();
  private pullState?: { model: string; pct: number };

  constructor() {
    document.body.classList.toggle('light', state.theme === 'light');
    document.body.classList.toggle('reduced', prefs.reducedMotion);
    this.ui.classList.add('booting');
    document.body.classList.add('booting');

    this.scene = new BrainScene(document.getElementById('scene') as HTMLCanvasElement, document.getElementById('labels')!, {
      theme: state.theme,
      quality: prefs.quality,
      autoRotate: prefs.autoRotate,
    });
    this.scene.graph.setHidden(prefs.hiddenTypes);

    this.hudRight = new HudRight(
      {
        palette: () => this.palette.toggle(),
        addProjects: () => this.addProject(),
        toggleTheme: () => this.setTheme(state.theme === 'dark' ? 'light' : 'dark'),
        settings: () => this.openSettings(),
      },
      state.theme,
    );
    this.legend = new Legend(new Set(prefs.hiddenTypes), (hidden) => {
      savePrefs({ hiddenTypes: [...hidden] });
      this.scene.graph.setHidden(hidden);
    });
    this.command = new CommandBar({
      submit: (p) => this.submit(p),
      stop: (runId) => api.cancelRun(runId).catch((e) => toast(e.message, 'error')),
      chooseProject: (id) => {
        this.setProject(id);
        if (id) this.selectNode(id, true);
      },
      addProject: () => this.addProject(),
      clearFollow: () => {
        state.followTaskId = undefined;
        this.renderContext();
      },
    });
    this.activity = new ActivityPanel({
      close: () => this.activity.hide(),
      cancel: (id) => api.cancelRun(id).catch((e) => toast(e.message, 'error')),
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
      useProject: (id) => {
        this.setProject(id);
        this.command.focus();
      },
      followUp: (id, title) => this.setFollow(id, title),
      openRun: (id) => this.openRun(id),
      toast: (m, e) => toast(m, e ? 'error' : 'ok'),
      refresh: () => this.loadGraph(),
      confirm: (m) => window.confirm(m),
    });
    this.palette = new CommandPalette(
      () => ({
        nodes: this.scene.graph.nodes(),
        actions: [
          { id: 'add', label: 'Aggiungi progetti', icon: 'folderPlus', run: () => this.addProject() },
          { id: 'settings', label: 'Impostazioni', icon: 'settings', run: () => this.openSettings() },
          { id: 'model', label: 'Cambia o scarica modello', icon: 'cpu', run: () => this.openSettings('model') },
          { id: 'theme', label: `Tema ${state.theme === 'dark' ? 'chiaro' : 'scuro'}`, icon: state.theme === 'dark' ? 'sun' : 'moon', hint: 'T', run: () => this.setTheme(state.theme === 'dark' ? 'light' : 'dark') },
          { id: 'home', label: 'Vista d’insieme', icon: 'target', run: () => this.goHome() },
          { id: 'core', label: 'Stato del cervello e scorciatoie', icon: 'core', run: () => this.selectNode('core', true) },
          ...(this.lastRun() ? [{ id: 'activity', label: 'Mostra l’ultima attività', icon: 'eye', run: () => this.activity.show(this.lastRun()!) }] : []),
        ],
      }),
      (id) => this.selectNode(id, true),
    );

    this.floatApproval.style.display = 'none';
    this.ui.append(
      this.hudRight.el,
      this.legend.el,
      this.banner.el,
      this.detail.el,
      this.activity.el,
      this.floatApproval,
      this.command.el,
      this.tooltip.el,
      this.offline.el,
    );
    mountToasts(this.ui);
    this.legend.render({});

    this.scene.onHover = (id, x, y) => this.tooltip.update(id ? this.scene.graph.get(id)?.node : undefined, x, y);
    this.scene.onSelect = (id) => (id ? this.selectNode(id, false) : this.deselect());
    this.bindKeys();

    this.ws = connectEvents(
      (e) => this.onEvent(e),
      (up) => {
        state.connected = up;
        this.offline.set(!up);
        if (up) {
          this.loadStatus();
          this.loadGraph();
        }
        this.renderStatus();
      },
    );
    setInterval(() => this.loadStatus(), 15000);
    this.bindZen();
    setInterval(() => this.tick(), 100);
    this.boot();
  }

  // ── boot ────────────────────────────────────────────────────
  private async boot() {
    const reveal = () => {
      this.ui.classList.remove('booting');
      document.body.classList.remove('booting');
    };
    if (!prefs.intro || prefs.reducedMotion) {
      reveal();
      return;
    }
    const intro = new Intro();
    this.ui.append(intro.el);
    const assembled = this.scene.playIntro(3.4);
    const finish = () => {
      intro.finish();
      reveal();
    };
    intro.onSkip = () => {
      this.scene.skipIntro();
      finish();
    };
    intro.progress(0.15);
    const status = await Promise.race([api.status().catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]);
    if (status) {
      intro.step('nucleo connesso');
      intro.progress(0.45);
      await wait(350);
      intro.step(status.llm.ok ? `${status.model} pronto` : `modello non pronto: ${status.model}`, status.llm.ok);
      intro.progress(0.7);
      const projects = await api.projects().catch(() => []);
      await wait(350);
      intro.step(projects.length ? `${projects.length} ${projects.length === 1 ? 'progetto' : 'progetti'} in memoria` : 'memoria pronta');
      intro.progress(0.9);
    } else intro.step('server non raggiungibile', false);
    await assembled;
    finish();
  }

  // ── chrome helpers ──────────────────────────────────────────
  private setTheme(t: 'dark' | 'light') {
    state.theme = t;
    savePrefs({ theme: t });
    document.body.classList.toggle('light', t === 'light');
    this.scene.setTheme(t);
    this.hudRight.setTheme(t);
  }

  private settingsOptions(tab?: SettingsOptions['tab']): SettingsOptions {
    return {
      tab,
      setTheme: (t) => this.setTheme(t),
      setAutoRotate: (on) => this.scene.setAutoRotate(on),
      setReducedMotion: (on) => document.body.classList.toggle('reduced', on),
      onSaved: () => this.loadStatus(),
      toast: (m, e) => toast(m, e ? 'error' : 'ok'),
      subscribePull: (fn) => {
        this.pullListeners.add(fn);
        return () => this.pullListeners.delete(fn);
      },
    };
  }

  private openSettings(tab?: SettingsOptions['tab']) {
    openSettings(this.settingsOptions(tab)).catch((e) => toast(e.message, 'error'));
  }

  private addProject() {
    openProjectPicker({
      toast: (m, e) => toast(m, e ? 'error' : 'ok'),
      onDone: async (added, existing) => {
        if (!added.length) {
          if (existing.length) toast('Quei progetti erano già collegati', 'info');
          return;
        }
        toast(added.length === 1 ? `“${added[0].name}” collegato — indicizzazione in corso` : `${added.length} progetti collegati — indicizzazione in corso`);
        this.welcomeDismissed = true;
        if (added.length === 1) this.setProject(added[0].id);
        await this.loadGraph();
        // each new cluster lights up in turn
        added.forEach((p, i) => setTimeout(() => this.scene.wave(p.id, 0xa78bfa), 350 + i * 260));
        setTimeout(() => (added.length === 1 ? this.selectNode(added[0].id, true) : this.goHome()), 400);
      },
    });
  }

  private goHome() {
    this.deselect();
    this.scene.home();
  }

  private bindKeys() {
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
      const modalOpen = !!this.ui.querySelector('.backdrop');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.palette.toggle();
        return;
      }
      if (this.palette.open || modalOpen) return;
      if (e.key === 'Escape') {
        if (typing) t.blur();
        else if (this.detail.nodeId) this.deselect();
        else if (this.activity.visibleRunId) this.activity.hide();
        else this.scene.home();
        return;
      }
      const a = this.floating;
      // Right after sending a prompt the (empty) command bar still has focus: approval keys must still work.
      const emptyCommand = t === this.command.textarea && !this.command.textarea.value;
      if ((typing && !(a && emptyCommand)) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (a && this.floatApproval.style.display !== 'none') {
        const k = e.key.toLowerCase();
        const act = (ok: boolean, scope: 'once' | 'run') => {
          e.preventDefault();
          this.approve(a.id, ok, scope);
        };
        if (k === 'n') return act(false, 'once');
        if (!a.danger && k === 'y') return act(true, 'once');
        if (!a.danger && k === 'a') return act(true, 'run');
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        this.command.focus();
      } else if (e.key === 't' || e.key === 'T') this.setTheme(state.theme === 'dark' ? 'light' : 'dark');
      else if (e.key === '?') this.selectNode('core', true);
    });
  }

  /** Zen mode: secondary controls dissolve after a few seconds without mouse/keyboard activity. */
  private bindZen() {
    let timer = 0;
    const wake = () => {
      document.body.classList.remove('zen');
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const busy = !!this.ui.querySelector('.backdrop, .palette-wrap, .menu') || document.activeElement?.tagName === 'INPUT';
        if (!busy) document.body.classList.add('zen');
      }, 4500);
    };
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, wake, { passive: true });
    wake();
  }

  /** 10 Hz: tokens/s and command-bar status. */
  private tick() {
    const now = performance.now();
    while (this.tokenTimes.length && now - this.tokenTimes[0] > 1500) this.tokenTimes.shift();
    const tps = this.tokenTimes.length > 2 ? this.tokenTimes.length / 1.5 : undefined;
    this.command.setRun(this.contextRun(), tps);
    if (this.activity.tps !== tps) {
      this.activity.tps = tps;
    }
  }

  // ── data ────────────────────────────────────────────────────
  private async loadStatus() {
    try {
      state.status = await api.status();
      const pending = state.status.pendingApprovals[0];
      if (pending) this.showFloatingApproval(pending);
    } catch {
      state.status = undefined;
    }
    this.renderStatus();
  }

  private renderStatus() {
    const s = state.status;
    const busy = [...state.runs.values()].some((r) => r.status === 'running');
    this.hudRight.setStatus({ connected: state.connected, ok: !!s?.llm.ok, model: s?.model, busy });
    if (!state.connected || !s) return this.banner.hide();
    if (this.pullState) {
      const p = this.pullState;
      this.banner.show(h('span', null, 'Scarico ', h('code', null, p.model), ` · ${p.pct}%`), h('span', { class: 'prog' }, h('i', { style: `width:${p.pct}%` })));
    } else if (!s.llm.ok && /not pulled/i.test(s.llm.detail)) {
      this.banner.show(
        h('span', null, 'Il modello ', h('code', null, s.model), ' non è ancora scaricato.'),
        h('button', { class: 'btn primary', style: 'height:30px', onclick: () => this.pull(s.model) }, icon('download', 14), 'Scarica ora'),
        h('button', { class: 'btn ghost', style: 'height:30px', onclick: () => this.openSettings('model') }, 'Scegli un altro'),
      );
    } else if (!s.llm.ok) {
      this.banner.show(h('span', null, 'Il motore AI locale non risponde. Avvia ', h('code', null, 'AI-Brain.bat'), ' (lo avvia da solo) oppure Ollama.'), h('button', { class: 'btn ghost', style: 'height:30px', onclick: () => this.loadStatus() }, icon('refresh', 14), 'Riprova'));
    } else this.banner.hide();
  }

  private pull(model: string) {
    this.pullState = { model, pct: 0 };
    this.renderStatus();
    api.pullModel(model).catch((e) => {
      this.pullState = undefined;
      toast(e.message, 'error');
      this.renderStatus();
    });
  }

  private async loadGraph() {
    try {
      const [g, projects] = await Promise.all([api.graph(), api.projects()]);
      state.graph = g;
      state.projects = projects;
      if (state.projectId && !projects.some((p) => p.id === state.projectId)) state.projectId = null;
      if (!state.projectId && projects.length === 1) state.projectId = projects[0].id;
      this.scene.setGraph(g);
      this.legend.render(this.scene.graph.counts());
      this.updateActivePath(g);
      this.renderContext();
      this.renderWelcome();
      const shown = this.detail.nodeId && g.nodes.find((n) => n.id === this.detail.nodeId);
      if (shown && (shown.type === 'project' || shown.type === 'task') && !document.activeElement?.closest('.panel.left')) this.detail.show(shown, true);
    } catch {
      /* offline: overlay handles it */
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
    const show = state.connected && state.projects.length === 0 && !this.welcomeDismissed && !this.activity.visibleRunId;
    if (show && !this.welcome) {
      this.welcome = welcomeCard(
        () => this.addProject(),
        () => {
          this.welcomeDismissed = true;
          this.renderWelcome();
          this.command.focus();
        },
      );
      this.ui.append(this.welcome);
    } else if (!show && this.welcome) {
      this.welcome.remove();
      this.welcome = undefined;
    }
  }

  // ── context ─────────────────────────────────────────────────
  private setProject(id: string | null) {
    state.projectId = id;
    state.followTaskId = undefined;
    this.renderContext();
  }

  private setFollow(taskId: string, title: string) {
    const run = [...state.runs.values()].find((r) => r.taskId === taskId);
    const node = state.graph?.nodes.find((n) => n.id === taskId);
    state.followTaskId = taskId;
    state.followTaskTitle = node?.label ?? title;
    state.projectId = run?.projectId ?? (node?.parent && node.parent !== 'core' ? node.parent : null);
    this.renderContext();
    this.command.focus();
  }

  private renderContext() {
    this.command.setContext(state.projects, state.projectId, state.followTaskId ? state.followTaskTitle : undefined);
  }

  private contextRun(): RunView | undefined {
    return [...state.runs.values()].find((r) => r.status === 'running' && r.projectId === state.projectId);
  }

  private lastRun(): RunView | undefined {
    return [...state.runs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  private async submit(prompt: string): Promise<boolean> {
    try {
      await api.startRun(prompt, state.projectId, state.followTaskId);
      state.followTaskId = undefined;
      this.welcomeDismissed = true;
      this.renderContext();
      this.renderWelcome();
      return true;
    } catch (err: any) {
      toast(err.message, 'error');
      return false;
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
    document.body.classList.add('has-left');
    if (node.type === 'task') {
      const live = [...state.runs.values()].find((r) => r.taskId === id && r.status === 'running');
      if (live) this.activity.show(live);
    }
  }

  private deselect() {
    state.selectedNode = undefined;
    this.scene.graph.selected = undefined;
    this.detail.hide();
    document.body.classList.remove('has-left');
  }

  private async openRun(runId: string) {
    let run = state.runs.get(runId);
    if (!run) {
      const { run: rec, events } = await api.run(runId);
      const start = events.find((e) => e.type === 'run.started');
      if (!start || start.type !== 'run.started') return toast('Log non disponibile per questa esecuzione', 'error');
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
      toast(`Ripristinati ${r.restored.length} file`);
      this.scene.wave(run?.taskId ?? 'core', 0x67e8f9);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  }

  private approve(id: string, approved: boolean, scope: 'once' | 'run') {
    this.ws.send({ type: 'approval', id, approved, scope });
    api.approve(id, approved, scope).catch(() => {}); // HTTP fallback; a duplicate resolve is a no-op
    if (this.floating?.id === id) this.hideFloatingApproval();
  }

  private showFloatingApproval(a: Approval) {
    this.floating = a;
    this.floatApproval.replaceChildren(
      h(
        'div',
        { class: `approval ${a.danger ? 'danger' : ''}` },
        h('div', { class: 'a-title' }, icon(a.danger ? 'alert' : 'shield', 16), a.danger ? 'L’agente vuole eseguire un’azione distruttiva' : 'L’agente chiede il permesso', h('span', { class: 'tool' }, a.tool)),
        h('pre', null, a.detail || a.summary),
        approvalButtons(a.id, a.danger, (id, ok, scope) => this.approve(id, ok, scope), true),
      ),
    );
    this.floatApproval.style.display = '';
  }

  private hideFloatingApproval() {
    this.floating = undefined;
    this.floatApproval.style.display = 'none';
  }

  // ── live events → UI + 3D choreography ─────────────────────
  private onEvent(e: BrainEvent) {
    const sc = this.scene;
    const pos = (id: string) => () => sc.graph.position(id);
    const pal = palette(state.theme);

    switch (e.type) {
      case 'hello':
        if (e.pendingApprovals[0]) this.showFloatingApproval(e.pendingApprovals[0]);
        sc.setActivity(e.activeRuns.length ? 0.6 : 0);
        return;
      case 'graph.changed':
        return this.scheduleGraph();
      case 'memory.added':
        sc.pulses.fire(pos('core'), pos('tool:memory'), { color: pal.memory.decision, size: 10 });
        return;
      case 'model.pull': {
        for (const fn of this.pullListeners) fn(e);
        if (e.done) {
          if (this.pullState?.model === e.model) this.pullState = undefined;
          if (e.error) toast(`${e.model}: ${e.error}`, 'error');
          else toast(`${e.model} scaricato e pronto`);
          this.loadStatus();
        } else if (this.pullState?.model === e.model || !this.pullState) {
          this.pullState = { model: e.model, pct: e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : 0 };
          this.renderStatus();
        }
        return;
      }
    }

    let run = 'runId' in e ? state.runs.get(e.runId) : undefined;
    if (e.type === 'run.started') {
      run = newRun(e);
      state.runs.set(e.runId, run);
      sc.setActivity(0.7);
      this.activity.show(run);
      this.renderWelcome();
      this.renderStatus();
      this.loadGraph().then(() => {
        sc.wave(e.projectId ?? 'core', state.theme === 'dark' ? 0xc4b5fd : 0x6d28d9);
        sc.pulses.chain([pos('core'), pos(e.projectId ?? 'core'), pos(e.taskId)], { color: pal.taskRunning, size: 12, duration: 0.7 });
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
        this.tokenTimes.push(now);
        if (now - this.lastSpark > 110) {
          this.lastSpark = now;
          sc.spark();
          sc.bumpActivity(0.03);
          if (Math.random() < 0.35) sc.pulses.fire(pos('core'), taskPos, { color: pal.fieldB, size: 5, duration: 0.8 });
        }
        break;
      }
      case 'tool.started': {
        const color = CATEGORY_COLOR[e.category] ?? pal.pulse;
        sc.pulses.chain([pos('core'), pos(`tool:${e.category}`), pos(hub), taskPos], { color, size: 10, duration: 0.55 });
        sc.bumpActivity(0.2);
        break;
      }
      case 'tool.output':
        if (Math.random() < 0.15) sc.spark(CATEGORY_COLOR.terminal);
        break;
      case 'tool.finished': {
        const item = run.items.find((i) => i.kind === 'tool' && i.callId === e.callId);
        const category = item && item.kind === 'tool' ? item.category : 'planning';
        sc.pulses.fire(taskPos, pos(`tool:${category}`), { color: e.ok ? pal.ok : pal.fail, size: 9, duration: 0.7 });
        break;
      }
      case 'plan.updated':
        e.steps.forEach((_, i) => setTimeout(() => sc.pulses.fire(pos('tool:planning'), taskPos, { color: CATEGORY_COLOR.planning, size: 8 }), i * 90));
        break;
      case 'approval.requested':
        this.showFloatingApproval(e);
        sc.pulses.fire(taskPos, pos('core'), { color: pal.taskRunning, size: 15, duration: 1.2 });
        break;
      case 'approval.resolved':
        if (this.floating?.id === e.id) this.hideFloatingApproval();
        break;
      case 'run.finished': {
        sc.setActivity(0);
        const color = e.status === 'done' ? pal.ok : e.status === 'failed' ? pal.fail : pal.pulse;
        sc.wave(run.taskId, color);
        const origin = sc.graph.position(run.taskId)?.clone() ?? new THREE.Vector3();
        for (let i = 0; i < 22; i++) {
          const dir = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 70);
          sc.pulses.fire(origin, origin.clone().add(dir), { color, size: 8, duration: 0.9 + Math.random() * 0.7, arc: 0.1 });
        }
        if (this.floating?.runId === run.runId) this.hideFloatingApproval();
        this.tokenTimes = [];
        this.tick();
        this.renderStatus();
        if (e.status === 'done') toast('Task completato');
        else if (e.status === 'failed') toast('Esecuzione terminata con errori — leggi il report', 'error');
        break;
      }
    }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
