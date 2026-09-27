import * as THREE from 'three';

const VERT = /* glsl */ `
  uniform float uPixelRatio;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vColor = aColor; vAlpha = aAlpha;
    gl_PointSize = aSize * uPixelRatio * (400.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 2.0);
    gl_FragColor = vec4(mix(vColor, vec3(1.0), pow(1.0 - d, 6.0)), a * vAlpha);
  }
`;

interface Pulse {
  from: THREE.Vector3 | (() => THREE.Vector3 | undefined);
  to: THREE.Vector3 | (() => THREE.Vector3 | undefined);
  t: number;
  duration: number;
  color: THREE.Color;
  size: number;
  arc: number;
  onArrive?: () => void;
}

const MAX = 700;
const TRAIL = 5;

/** Bright impulses travelling along curved paths between nodes (the agent "thinking" and "acting"). */
export class PulseLayer {
  readonly points: THREE.Points;
  private pulses: Pulse[] = [];
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;

  constructor(pixelRatio: number) {
    const mk = (n: number) => new THREE.BufferAttribute(new Float32Array(MAX * TRAIL * n), n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', mk(3));
    this.geo.setAttribute('aColor', mk(3));
    this.geo.setAttribute('aSize', mk(1));
    this.geo.setAttribute('aAlpha', mk(1));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: pixelRatio } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setLight(light: boolean) {
    this.mat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.mat.needsUpdate = true;
  }

  /** Endpoints can be functions so pulses follow nodes that are still moving. */
  fire(from: Pulse['from'], to: Pulse['to'], opts: { color: THREE.ColorRepresentation; duration?: number; size?: number; arc?: number; onArrive?: () => void }) {
    if (this.pulses.length >= MAX) this.pulses.shift();
    this.pulses.push({
      from,
      to,
      t: 0,
      duration: opts.duration ?? 0.9,
      color: new THREE.Color(opts.color),
      size: opts.size ?? 7,
      arc: opts.arc ?? 0.25,
      onArrive: opts.onArrive,
    });
  }

  /** Fire along a chain of points: a → b → c … (each hop starts when the previous arrives). */
  chain(points: (() => THREE.Vector3 | undefined)[], opts: { color: THREE.ColorRepresentation; duration?: number; size?: number }) {
    const hop = (i: number) => {
      if (i + 1 >= points.length) return;
      this.fire(points[i], points[i + 1], { ...opts, onArrive: () => hop(i + 1) });
    };
    hop(0);
  }

  get count() {
    return this.pulses.length;
  }

  update(dt: number) {
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geo.getAttribute('aColor') as THREE.BufferAttribute;
    const size = this.geo.getAttribute('aSize') as THREE.BufferAttribute;
    const alpha = this.geo.getAttribute('aAlpha') as THREE.BufferAttribute;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
    let w = 0;
    const alive: Pulse[] = [];
    const arrived: (() => void)[] = [];
    for (const pl of this.pulses) {
      pl.t += dt / pl.duration;
      const from = typeof pl.from === 'function' ? pl.from() : pl.from;
      const to = typeof pl.to === 'function' ? pl.to() : pl.to;
      if (!from || !to) continue;
      if (pl.t >= 1) {
        if (pl.onArrive) arrived.push(pl.onArrive);
        continue;
      }
      alive.push(pl);
      a.copy(from);
      b.copy(to);
      // control point: midpoint pushed outward from the brain centre for a graceful arc
      c.addVectors(a, b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      c.add(c.clone().normalize().multiplyScalar(len * pl.arc));
      for (let k = 0; k < TRAIL; k++) {
        const t = Math.max(0, easeInOut(pl.t) - k * 0.035);
        const u = 1 - t;
        p.set(0, 0, 0).addScaledVector(a, u * u).addScaledVector(c, 2 * u * t).addScaledVector(b, t * t);
        pos.setXYZ(w, p.x, p.y, p.z);
        col.setXYZ(w, pl.color.r, pl.color.g, pl.color.b);
        size.setX(w, pl.size * (1 - k / TRAIL) * (k === 0 ? 1.3 : 1));
        alpha.setX(w, Math.min(1, pl.t * 6, (1 - pl.t) * 6) * (1 - k / TRAIL));
        w++;
      }
    }
    this.pulses = alive;
    for (const fn of arrived) fn(); // may fire follow-up hops
    this.geo.setDrawRange(0, w);
    for (const x of [pos, col, size, alpha]) x.needsUpdate = true;
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
