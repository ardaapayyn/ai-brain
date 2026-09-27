import * as THREE from 'three';
import type { Graph, GraphNode } from '../types';
import { nodeColor, type Theme } from './palette';

const NODE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uLight;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aState;   // 0 idle · 1 running · 2 hovered · 3 selected
  attribute float aSeed;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vState;
  varying float vAlpha;
  varying float vPulse;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = aState > 0.5 && aState < 1.5 ? 0.5 + 0.5 * sin(uTime * 5.0 + aSeed * 6.28) : 0.0;
    float breathe = 1.0 + 0.06 * sin(uTime * 1.3 + aSeed * 12.0);
    float grow = aState > 1.5 ? 1.45 : 1.0;
    vPulse = pulse; vColor = aColor; vState = aState; vAlpha = aAlpha;
    gl_PointSize = aSize * breathe * grow * (1.0 + pulse * 0.6) * uPixelRatio * (420.0 / -mv.z) * mix(1.0, 1.9, uLight);
    gl_Position = projectionMatrix * mv;
  }
`;

const NODE_FRAG = /* glsl */ `
  uniform float uLight;
  varying vec3 vColor;
  varying float vState;
  varying float vAlpha;
  varying float vPulse;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.34, 0.22, d);
    float halo = pow(1.0 - d, 2.6) * (0.55 + vPulse * 0.8);
    float ring = vState > 2.5 ? smoothstep(0.08, 0.0, abs(d - 0.62)) * 0.9 : 0.0;
    vec3 col = mix(vColor, vec3(1.0), core * 0.55 * (1.0 - uLight));
    float a = max(core, halo) + ring;
    if (uLight > 0.5) { col = mix(vColor, vColor * 0.7, core); a = core + halo * 0.7 + ring; }
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * vAlpha);
  }
`;

const EDGE_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aT;
  attribute float aActive;
  attribute float aVis;
  varying vec3 vColor;
  varying float vT;
  varying float vActive;
  varying float vVis;
  void main() {
    vColor = aColor; vT = aT; vActive = aActive; vVis = aVis;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EDGE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uLight;
  varying vec3 vColor;
  varying float vT;
  varying float vActive;
  varying float vVis;
  void main() {
    float flow = vActive * smoothstep(0.3, 0.0, abs(fract(vT - uTime * 0.9) - 0.5));
    float a = (mix(0.22, 0.5, uLight) + flow * 0.7 + vActive * 0.12) * vVis;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), flow * 0.5 * (1.0 - uLight)), a);
  }
`;

const SIZE: Record<GraphNode['type'], number> = { core: 30, tool: 12, project: 22, module: 9, task: 11, memory: 7 };
const SHELL: Partial<Record<GraphNode['type'], number>> = { module: 26, task: 38, memory: 50 };

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Evenly distributed direction #i of n on a sphere (Fibonacci), rotated by a seed. */
function fib(i: number, n: number, seed = 0, out = new THREE.Vector3()) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = n <= 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const t = golden * i + seed * Math.PI * 2;
  return out.set(Math.cos(t) * r, y, Math.sin(t) * r);
}

interface NodeView {
  node: GraphNode;
  index: number;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  color: THREE.Color;
  alpha: number;
  targetAlpha: number;
  label?: HTMLDivElement;
  screen: { x: number; y: number; z: number; visible: boolean };
}

const MAX_NODES = 4000;
const MAX_EDGES = 6000;

/** Semantic layer: core, tools, projects, modules, tasks, memories — laid out as clusters inside the brain. */
export class GraphLayer {
  readonly group = new THREE.Group();
  private views = new Map<string, NodeView>();
  private order: NodeView[] = [];
  private edges: [string, string][] = [];
  private nodeGeo = new THREE.BufferGeometry();
  private edgeGeo = new THREE.BufferGeometry();
  private nodeMat: THREE.ShaderMaterial;
  private edgeMat: THREE.ShaderMaterial;
  private theme: Theme;
  hovered?: string;
  selected?: string;
  private activeEdges = new Set<string>();
  private hidden = new Set<string>();
  private focusFor?: string;
  private focusSet?: Set<string>;

  constructor(private labelsEl: HTMLElement, pixelRatio: number, theme: Theme) {
    this.theme = theme;
    const nAttr = (n: number, size: number) => new THREE.BufferAttribute(new Float32Array(MAX_NODES * size), size).setUsage(THREE.DynamicDrawUsage);
    this.nodeGeo.setAttribute('position', nAttr(MAX_NODES, 3));
    this.nodeGeo.setAttribute('aColor', nAttr(MAX_NODES, 3));
    this.nodeGeo.setAttribute('aSize', nAttr(MAX_NODES, 1));
    this.nodeGeo.setAttribute('aState', nAttr(MAX_NODES, 1));
    this.nodeGeo.setAttribute('aSeed', nAttr(MAX_NODES, 1));
    this.nodeGeo.setAttribute('aAlpha', nAttr(MAX_NODES, 1));
    this.nodeGeo.setDrawRange(0, 0);
    const uniforms = { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio }, uLight: { value: theme === 'light' ? 1 : 0 } };
    this.nodeMat = new THREE.ShaderMaterial({ uniforms, vertexShader: NODE_VERT, fragmentShader: NODE_FRAG, transparent: true, depthWrite: false });
    const nodes = new THREE.Points(this.nodeGeo, this.nodeMat);
    nodes.frustumCulled = false;
    nodes.renderOrder = 2;

    const eAttr = (size: number) => new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 2 * size), size).setUsage(THREE.DynamicDrawUsage);
    this.edgeGeo.setAttribute('position', eAttr(3));
    this.edgeGeo.setAttribute('aColor', eAttr(3));
    this.edgeGeo.setAttribute('aT', eAttr(1));
    this.edgeGeo.setAttribute('aActive', eAttr(1));
    this.edgeGeo.setAttribute('aVis', eAttr(1));
    this.edgeGeo.setDrawRange(0, 0);
    this.edgeMat = new THREE.ShaderMaterial({ uniforms, vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG, transparent: true, depthWrite: false });
    const lines = new THREE.LineSegments(this.edgeGeo, this.edgeMat);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    this.group.add(lines, nodes);
    this.setTheme(theme);
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    const light = theme === 'light';
    this.nodeMat.uniforms.uLight.value = light ? 1 : 0;
    for (const m of [this.nodeMat, this.edgeMat]) {
      m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      m.needsUpdate = true;
    }
    for (const v of this.views.values()) v.color = nodeColor(v.node, theme);
  }

  get(id: string) {
    return this.views.get(id);
  }
  position(id: string): THREE.Vector3 | undefined {
    return this.views.get(id)?.pos;
  }
  nodes() {
    return this.order.map((v) => v.node);
  }

  /** Merge a new graph snapshot; existing nodes keep their position and glide to new targets. */
  setGraph(g: Graph) {
    const incoming = new Map(g.nodes.slice(0, MAX_NODES).map((n) => [n.id, n]));
    for (const [id, v] of this.views) {
      if (!incoming.has(id)) {
        v.label?.remove();
        this.views.delete(id);
      }
    }
    const targets = this.computeTargets(g.nodes.filter((n) => incoming.has(n.id)));
    for (const n of incoming.values()) {
      let v = this.views.get(n.id);
      const target = targets.get(n.id)!;
      if (!v) {
        const parentPos = n.parent ? this.views.get(n.parent)?.pos : undefined;
        v = {
          node: n,
          index: 0,
          pos: (parentPos ?? target).clone(),
          target,
          color: nodeColor(n, this.theme),
          alpha: 0,
          targetAlpha: 1,
          screen: { x: 0, y: 0, z: 0, visible: false },
        };
        this.views.set(n.id, v);
      } else {
        v.node = n;
        v.target = target;
        v.color = nodeColor(n, this.theme);
      }
    }
    this.order = [...this.views.values()];
    this.order.forEach((v, i) => (v.index = i));
    this.edges = g.edges.filter(([a, b]) => this.views.has(a) && this.views.has(b)).slice(0, MAX_EDGES);
    this.focusFor = undefined;
    const seed = this.nodeGeo.getAttribute('aSeed') as THREE.BufferAttribute;
    for (const v of this.order) seed.setX(v.index, hash(v.node.id));
    seed.needsUpdate = true;
    this.nodeGeo.setDrawRange(0, this.order.length);
    this.edgeGeo.setDrawRange(0, this.edges.length * 2);
  }

  private computeTargets(nodes: GraphNode[]): Map<string, THREE.Vector3> {
    const out = new Map<string, THREE.Vector3>();
    const byParent = new Map<string, GraphNode[]>();
    for (const n of nodes) if (n.parent) (byParent.get(n.parent) ?? byParent.set(n.parent, []).get(n.parent)!).push(n);
    out.set('core', new THREE.Vector3(0, 8, 0));

    const tools = nodes.filter((n) => n.type === 'tool');
    tools.forEach((t, i) => {
      const a = (i / tools.length) * Math.PI * 2;
      out.set(t.id, new THREE.Vector3(Math.cos(a) * 42, 8 + Math.sin(a * 2) * 10, Math.sin(a) * 42));
    });

    // Projects + the scratch cluster (tasks attached directly to the core) on a Fibonacci shell.
    const clusters = nodes.filter((n) => n.type === 'project').map((n) => n.id);
    const coreChildren = (byParent.get('core') ?? []).filter((n) => n.type === 'task');
    if (coreChildren.length) clusters.push('__scratch');
    const shell = clusters.length <= 1 ? 88 : 96;
    const centers = new Map<string, THREE.Vector3>();
    clusters.forEach((id, i) => {
      // Few clusters: a gently tilted ring (reads well from the default camera). Many: Fibonacci sphere.
      const n = clusters.length;
      const a = (i / n) * Math.PI * 2 + 1.1;
      const dir = n <= 7 ? new THREE.Vector3(Math.cos(a), 0.28 * Math.sin(a * 2 + 0.5), Math.sin(a)).normalize() : fib(i, n, 0.13);
      const c = dir.multiplyScalar(shell).add(new THREE.Vector3(0, 8, 0));
      centers.set(id, c);
      if (id !== '__scratch') out.set(id, c.clone());
    });

    const placeChildren = (parentId: string, center: THREE.Vector3, kids: GraphNode[], scale = 1) => {
      const groups: Record<string, GraphNode[]> = {};
      for (const k of kids) (groups[k.type] ??= []).push(k);
      for (const [type, list] of Object.entries(groups)) {
        const radius = (SHELL[type as GraphNode['type']] ?? 30) * scale * (1 + Math.min(list.length, 60) / 90);
        list.forEach((k, i) => {
          const dir = fib(i, Math.max(list.length, 2), hash(parentId + type));
          const jitter = 0.9 + hash(k.id) * 0.2;
          out.set(k.id, center.clone().add(dir.multiplyScalar(radius * jitter)));
        });
      }
    };
    for (const id of clusters) {
      const kids = id === '__scratch' ? coreChildren : byParent.get(id) ?? [];
      placeChildren(id, centers.get(id)!, kids);
    }
    const mem = out.get('tool:memory');
    if (mem) placeChildren('tool:memory', mem, byParent.get('tool:memory') ?? [], 0.45);

    for (const n of nodes) if (!out.has(n.id)) out.set(n.id, new THREE.Vector3((hash(n.id) - 0.5) * 60, (hash(n.id + 'y') - 0.5) * 60, (hash(n.id + 'z') - 0.5) * 60));
    return out;
  }

  /** Hide whole node types (legend toggles). */
  setHidden(types: Iterable<string>) {
    this.hidden = new Set(types);
  }

  counts(): Record<string, number> {
    const c: Record<string, number> = {};
    for (const v of this.order) c[v.node.type] = (c[v.node.type] ?? 0) + 1;
    return c;
  }

  /** Selected node + its direct neighbours + ancestors stay bright; the rest dims. */
  private focus(): Set<string> | undefined {
    if (!this.selected || this.selected === 'core') return undefined;
    if (this.focusFor === this.selected && this.focusSet) return this.focusSet;
    const set = new Set<string>([this.selected, 'core']);
    for (const [a, b] of this.edges) {
      if (a === this.selected) set.add(b);
      if (b === this.selected) set.add(a);
    }
    let p = this.views.get(this.selected)?.node.parent;
    while (p && !set.has(p + '#')) {
      set.add(p);
      set.add(p + '#');
      p = this.views.get(p)?.node.parent;
    }
    // entering a project keeps its whole cluster lit
    for (const v of this.order) if (v.node.parent && set.has(v.node.parent) && this.views.get(this.selected)?.node.type === 'project') set.add(v.node.id);
    this.focusFor = this.selected;
    this.focusSet = set;
    return set;
  }

  /** Light up edges on the path to a node (e.g. the task being worked on). */
  setActivePath(ids: string[]) {
    this.activeEdges.clear();
    for (let i = 0; i + 1 < ids.length; i++) this.activeEdges.add(`${ids[i]}|${ids[i + 1]}`).add(`${ids[i + 1]}|${ids[i]}`);
  }

  update(time: number, dt: number, camera: THREE.Camera, width: number, height: number) {
    this.nodeMat.uniforms.uTime.value = time;
    const pos = this.nodeGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.nodeGeo.getAttribute('aColor') as THREE.BufferAttribute;
    const size = this.nodeGeo.getAttribute('aSize') as THREE.BufferAttribute;
    const state = this.nodeGeo.getAttribute('aState') as THREE.BufferAttribute;
    const alpha = this.nodeGeo.getAttribute('aAlpha') as THREE.BufferAttribute;
    const k = 1 - Math.pow(0.02, dt); // frame-rate independent easing
    const v3 = new THREE.Vector3();
    const focus = this.focus();
    for (const v of this.order) {
      v.targetAlpha = this.hidden.has(v.node.type) ? 0 : focus && !focus.has(v.node.id) ? 0.28 : 1;
      v.pos.lerp(v.target, k * 0.9);
      v.alpha += (v.targetAlpha - v.alpha) * k;
      const i = v.index;
      pos.setXYZ(i, v.pos.x, v.pos.y, v.pos.z);
      col.setXYZ(i, v.color.r, v.color.g, v.color.b);
      size.setX(i, SIZE[v.node.type] * (0.8 + Math.min(v.node.weight, 8) * 0.06));
      state.setX(i, v.node.id === this.selected ? 3 : v.node.id === this.hovered ? 2 : v.node.status === 'running' ? 1 : 0);
      alpha.setX(i, v.alpha);
      v3.copy(v.pos).project(camera);
      v.screen.visible = v3.z < 1 && v3.z > -1;
      v.screen.x = (v3.x * 0.5 + 0.5) * width;
      v.screen.y = (-v3.y * 0.5 + 0.5) * height;
      v.screen.z = v3.z;
    }
    for (const a of [pos, col, size, state, alpha]) a.needsUpdate = true;

    const ep = this.edgeGeo.getAttribute('position') as THREE.BufferAttribute;
    const ec = this.edgeGeo.getAttribute('aColor') as THREE.BufferAttribute;
    const et = this.edgeGeo.getAttribute('aT') as THREE.BufferAttribute;
    const ea = this.edgeGeo.getAttribute('aActive') as THREE.BufferAttribute;
    const ev = this.edgeGeo.getAttribute('aVis') as THREE.BufferAttribute;
    this.edges.forEach(([a, b], i) => {
      const va = this.views.get(a)!, vb = this.views.get(b)!;
      const touches = !!this.selected && (a === this.selected || b === this.selected);
      const active = this.activeEdges.has(`${a}|${b}`) ? 1 : touches ? 0.6 : 0;
      const vis = Math.min(va.alpha, vb.alpha) * (focus && !touches ? 0.5 : 1);
      ev.setX(i * 2, vis);
      ev.setX(i * 2 + 1, vis);
      ep.setXYZ(i * 2, va.pos.x, va.pos.y, va.pos.z);
      ep.setXYZ(i * 2 + 1, vb.pos.x, vb.pos.y, vb.pos.z);
      ec.setXYZ(i * 2, va.color.r, va.color.g, va.color.b);
      ec.setXYZ(i * 2 + 1, vb.color.r, vb.color.g, vb.color.b);
      // aT runs 0→length so the flow pattern has constant world-space spacing.
      et.setX(i * 2, 0);
      et.setX(i * 2 + 1, va.pos.distanceTo(vb.pos) / 40);
      ea.setX(i * 2, active);
      ea.setX(i * 2 + 1, active);
    });
    for (const a of [ep, ec, et, ea, ev]) a.needsUpdate = true;
    this.updateLabels(camera);
  }

  /**
   * DOM labels with collision avoidance: candidates are ranked (hovered/selected/running first,
   * then projects, then by distance) and placed greedily; a label that would overlap one already
   * placed stays hidden until you hover its node.
   */
  private updateLabels(camera: THREE.Camera) {
    const camPos = (camera as THREE.PerspectiveCamera).position;
    const TYPE_RANK: Record<string, number> = { core: 1, project: 2, task: 3, tool: 4, module: 5, memory: 6 };
    const candidates: { v: NodeView; rank: number; dist: number; fade: number }[] = [];
    for (const v of this.order) {
      const n = v.node;
      const dist = camPos.distanceTo(v.pos);
      const hot = n.id === this.hovered || n.id === this.selected || n.status === 'running';
      const important = hot || n.type === 'core' || n.type === 'project';
      const near = n.type === 'tool' ? dist < 260 : n.type === 'module' || n.type === 'task' ? dist < 170 : dist < 110;
      if (!(v.screen.visible && v.alpha > 0.55 && (important || near))) {
        if (v.label) v.label.style.opacity = '0';
        continue;
      }
      const fade = important ? 1 : Math.max(0, Math.min(1, (n.type === 'tool' ? 260 : n.type === 'memory' ? 110 : 170) / dist - 0.6));
      candidates.push({ v, rank: hot ? 0 : TYPE_RANK[n.type] ?? 9, dist, fade });
    }
    candidates.sort((a, b) => a.rank - b.rank || a.dist - b.dist);
    const placed: [number, number, number, number][] = [];
    for (const { v, rank, fade } of candidates) {
      const n = v.node;
      if (!v.label) {
        v.label = document.createElement('div');
        v.label.className = `node-label t-${n.type}`;
        this.labelsEl.appendChild(v.label);
      }
      const text = n.type === 'tool' ? n.label.toUpperCase() : n.label.length > 48 ? n.label.slice(0, 46) + '…' : n.label;
      if (v.label.textContent !== text) {
        v.label.textContent = text;
        (v.label as any)._w = 0;
      }
      const w: number = (v.label as any)._w || ((v.label as any)._w = v.label.offsetWidth || text.length * 7);
      const hgt = n.type === 'project' ? 20 : 15;
      const x = v.screen.x - w / 2;
      const y = v.screen.y + 12 + SIZE[n.type] * 0.15;
      const box: [number, number, number, number] = [x - 4, y - 2, x + w + 4, y + hgt];
      const hits = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      if (hits && rank > 0) {
        v.label.style.opacity = '0';
        continue;
      }
      placed.push(box);
      v.label.classList.toggle('is-hot', n.id === this.hovered || n.id === this.selected);
      v.label.classList.toggle('is-running', n.status === 'running');
      v.label.style.opacity = String(fade);
      v.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  /** Screen-space picking: closest node under the cursor (front-most wins ties). */
  pick(x: number, y: number, camera: THREE.Camera): string | undefined {
    const camPos = (camera as THREE.PerspectiveCamera).position;
    let best: string | undefined;
    let bestScore = Infinity;
    for (const v of this.order) {
      if (!v.screen.visible || v.alpha < 0.2) continue;
      const dist = camPos.distanceTo(v.pos);
      const radius = Math.max(10, (SIZE[v.node.type] * 420) / dist / 2.2);
      const d = Math.hypot(v.screen.x - x, v.screen.y - y);
      if (d > radius) continue;
      const score = d / radius + v.screen.z * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = v.node.id;
      }
    }
    return best;
  }
}
