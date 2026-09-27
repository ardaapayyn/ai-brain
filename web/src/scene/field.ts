import * as THREE from 'three';
import { palette, type Theme } from './palette';

/**
 * The ambient "living brain": thousands of neurons shaped like two hemispheres + cerebellum,
 * connected by synapses. Everything animates on the GPU — the boot-time assembly, breathing,
 * twinkling, impulses racing along synapses, and shockwaves when the agent starts/finishes work.
 */

const COMMON = /* glsl */ `
  uniform float uTime;
  uniform float uActivity;
  uniform float uLight;
  uniform float uAssemble;
  uniform float uWaveTime;
  uniform vec3 uWaveOrigin;
  float assembleT(float phase) {
    float t = clamp(uAssemble * 1.7 - phase * 0.7, 0.0, 1.0);
    return 1.0 - pow(1.0 - t, 4.0);
  }
  float waveAt(vec3 p) {
    if (uWaveTime < 0.0) return 0.0;
    float r = uWaveTime * 190.0;
    float d = distance(p, uWaveOrigin);
    return exp(-pow((d - r) / 18.0, 2.0)) * max(0.0, 1.0 - uWaveTime / 2.2);
  }
`;

const NEURON_VERT = /* glsl */ `
  ${COMMON}
  uniform float uPixelRatio;
  attribute float aPhase;
  attribute float aSize;
  attribute vec3 aColor;
  attribute vec3 aStart;
  varying vec3 vColor;
  varying float vTwinkle;
  varying float vNear;
  varying float vWave;
  varying float vFly;
  void main() {
    float e = assembleT(aPhase);
    vec3 p = mix(aStart, position, e);
    p *= 1.0 + 0.012 * sin(uTime * 0.6);
    p += normalize(p + 0.001) * sin(uTime * (0.6 + aPhase * 0.4) + aPhase * 40.0) * 0.9;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float speed = 1.2 + uActivity * 5.0;
    vTwinkle = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * speed + aPhase * 97.0), 6.0);
    vWave = waveAt(p);
    vFly = e;
    vColor = aColor;
    gl_PointSize = aSize * uPixelRatio * (320.0 / -mv.z) * (1.0 + uActivity * 0.35 * vTwinkle) * (1.0 + vWave * 1.4) * mix(1.0, 2.8, uLight);
    // fade what is very close (inside the cloud) and dim the far half for depth
    vNear = smoothstep(70.0, 270.0, -mv.z) * mix(1.0, 0.45, smoothstep(380.0, 700.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const NEURON_FRAG = /* glsl */ `
  uniform float uActivity;
  uniform float uLight;
  uniform vec3 uWaveColor;
  varying vec3 vColor;
  varying float vTwinkle;
  varying float vNear;
  varying float vWave;
  varying float vFly;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float a = pow(core, 1.8) * vTwinkle * (0.55 + uActivity * 0.45) * vNear;
    a = a * mix(0.55, 2.6, uLight) + vWave * core * 0.55;
    a *= mix(0.35, 1.0, vFly);
    vec3 col = mix(vColor * (1.0 + (1.0 - uLight) * 0.4 * vTwinkle), uWaveColor, clamp(vWave * 0.9, 0.0, 0.75));
    gl_FragColor = vec4(col, min(1.0, a));
  }
`;

const SYNAPSE_VERT = /* glsl */ `
  ${COMMON}
  attribute float aT;
  attribute float aPhase;
  attribute vec3 aColor;
  varying float vT;
  varying float vPhase;
  varying vec3 vColor;
  varying float vWave;
  void main() {
    vec3 p = position * (1.0 + 0.012 * sin(uTime * 0.6));
    vT = aT; vPhase = aPhase; vColor = aColor;
    vWave = waveAt(p);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const SYNAPSE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uActivity;
  uniform float uLight;
  uniform float uAssemble;
  uniform vec3 uWaveColor;
  varying float vT;
  varying float vPhase;
  varying vec3 vColor;
  varying float vWave;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    float speed = 0.35 + uActivity * 1.4;
    float cycle = uTime * speed + vPhase * 17.0;
    float idx = floor(cycle);
    float rate = 0.10 + uActivity * 0.55;
    float fires = step(hash(idx * 1.7 + vPhase * 91.0), rate);
    float pulse = fires * smoothstep(0.14, 0.0, abs(fract(cycle) - vT));
    float base = mix(0.022, 0.26, uLight) + uActivity * 0.025;
    float a = (base + pulse * 0.65 + vWave * 0.7) * smoothstep(0.75, 1.0, uAssemble);
    vec3 col = mix(vColor, vec3(1.0), pulse * 0.6 * (1.0 - uLight));
    col = mix(col, uWaveColor, clamp(vWave, 0.0, 0.9));
    gl_FragColor = vec4(col, a);
  }
`;

function rand(seed: { s: number }) {
  // mulberry32 — deterministic brain shape across reloads
  let t = (seed.s += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const BRAIN_RADIUS = 150;

/**
 * Sample a point on a stylised but anatomically-readable brain:
 * two hemispheres split by a clear longitudinal fissure, visible gyri (points are concentrated on
 * fold ridges), temporal lobes, a cerebellum and the brain stem. Front of the brain is +z.
 */
function brainPoint(r: () => number, out: THREE.Vector3): THREE.Vector3 {
  const R = BRAIN_RADIUS;
  const pick = r();
  if (pick < 0.86) {
    for (let tries = 0; tries < 12; tries++) {
      const side = r() < 0.5 ? -1 : 1;
      const u = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      if (u.lengthSq() > 1 || u.lengthSq() < 1e-4) continue;
      u.normalize();
      if (u.x * side < 0) u.x *= 0.08; // flat medial wall → deep fissure between hemispheres
      const theta = Math.atan2(u.z, u.y);
      const phi = Math.acos(THREE.MathUtils.clamp(u.x * side, -1, 1));
      // gyri: sum of a few oriented waves; points prefer the ridges
      const fold = Math.sin(theta * 7.0 + Math.sin(phi * 3.1) * 1.6) * 0.55 + Math.sin(phi * 9.0 + theta * 2.3) * 0.45;
      const ridge = 1 - Math.abs(fold);
      const surface = r() < 0.9;
      if (surface && r() > 0.25 + 0.75 * ridge * ridge) continue;
      const shell = surface ? 0.93 + 0.07 * Math.sqrt(r()) : 0.3 + 0.55 * Math.cbrt(r());
      const rr = R * shell * (1 + 0.045 * fold);
      let x = u.x * rr * 0.6 + side * R * 0.085;
      let y = u.y * rr * 0.74 + R * 0.08;
      let z = u.z * rr * 1.06;
      // flatter base, fuller top
      if (y < 0) y *= 0.82;
      // temporal lobes: lateral-inferior bulge in the middle third
      if (u.y < 0.05 && u.z > -0.35 && u.z < 0.55) {
        const k = (1 - Math.abs(u.z - 0.1) / 0.45) * Math.min(1, -u.y * 3 + 0.2);
        x += side * R * 0.07 * k;
        y -= R * 0.06 * k;
      }
      // frontal lobe slightly narrower, occipital slightly lower
      x *= 1 - 0.08 * Math.max(0, u.z);
      if (u.z < -0.5) y -= R * 0.04 * (-u.z - 0.5);
      return out.set(x, y, z);
    }
    return out.set(0, R * 0.2, 0);
  }
  if (pick < 0.96) {
    // cerebellum: small, finely striped, back-bottom
    const u = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    const stripes = 1 + 0.06 * Math.sin(u.y * 42);
    const rr = R * 0.33 * (0.82 + 0.18 * Math.sqrt(r())) * stripes;
    return out.set(u.x * rr * 1.3, u.y * rr * 0.55 - R * 0.5, u.z * rr * 0.75 - R * 0.6);
  }
  const a = r() * Math.PI * 2;
  const rr = R * 0.09 * Math.sqrt(r());
  const h = r();
  return out.set(Math.cos(a) * rr, -R * 0.32 - h * R * 0.55, Math.sin(a) * rr - R * 0.22 - h * R * 0.14);
}

export class NeuralField {
  readonly group = new THREE.Group();
  readonly uniforms = {
    uTime: { value: 0 },
    uActivity: { value: 0 },
    uPixelRatio: { value: 1 },
    uLight: { value: 0 },
    uAssemble: { value: 1 },
    uWaveTime: { value: -1 },
    uWaveOrigin: { value: new THREE.Vector3() },
    uWaveColor: { value: new THREE.Color(0xffffff) },
  };
  private neuronMat: THREE.ShaderMaterial;
  private synapseMat: THREE.ShaderMaterial;
  private neuronColors: THREE.BufferAttribute;
  private synapseColors: THREE.BufferAttribute;
  private synapseMix: number[];
  private positions: Float32Array;
  private mix: Float32Array;

  constructor(count: number, pixelRatio: number, theme: Theme) {
    this.uniforms.uPixelRatio.value = pixelRatio;
    const seed = { s: 1337 };
    const r = () => rand(seed);
    this.positions = new Float32Array(count * 3);
    const starts = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const sizes = new Float32Array(count);
    this.mix = new Float32Array(count);
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      brainPoint(r, v);
      this.positions.set([v.x, v.y, v.z], i * 3);
      // assembly start: a wide, swirling shell far outside the brain
      s.set(r() * 2 - 1, (r() * 2 - 1) * 0.6, r() * 2 - 1).normalize().multiplyScalar(520 + r() * 900);
      starts.set([s.x, s.y, s.z], i * 3);
      phases[i] = r();
      sizes[i] = 1.0 + Math.pow(r(), 7) * 4.5;
      this.mix[i] = THREE.MathUtils.clamp(0.5 + v.x / (BRAIN_RADIUS * 1.3) + (r() - 0.5) * 0.35, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('aStart', new THREE.BufferAttribute(starts, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.neuronColors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    g.setAttribute('aColor', this.neuronColors);

    this.neuronMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: NEURON_VERT, fragmentShader: NEURON_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const points = new THREE.Points(g, this.neuronMat);
    points.frustumCulled = false;
    this.group.add(points);

    // Synapses: connect a subset of neurons to their nearest neighbours (spatial hash).
    const cell = 16;
    const grid = new Map<string, number[]>();
    const P = this.positions;
    for (let i = 0; i < count; i++) {
      const k = `${Math.floor(P[i * 3] / cell)},${Math.floor(P[i * 3 + 1] / cell)},${Math.floor(P[i * 3 + 2] / cell)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
    const segs: number[] = [];
    const segT: number[] = [];
    const segPhase: number[] = [];
    this.synapseMix = [];
    const sources = Math.floor(count * 0.3);
    for (let n = 0; n < sources; n++) {
      const i = Math.floor(r() * count);
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
      const near: { j: number; d: number }[] = [];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              if (j === i) continue;
              const d = Math.hypot(P[j * 3] - px, P[j * 3 + 1] - py, P[j * 3 + 2] - pz);
              if (d > 3 && d < cell * 1.3) near.push({ j, d });
            }
      near.sort((a, b) => a.d - b.d);
      const phase = r();
      for (const { j } of near.slice(0, 2)) {
        segs.push(px, py, pz, P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
        segT.push(0, 1);
        segPhase.push(phase, phase);
        this.synapseMix.push(this.mix[i], this.mix[j]);
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    sg.setAttribute('aT', new THREE.Float32BufferAttribute(segT, 1));
    sg.setAttribute('aPhase', new THREE.Float32BufferAttribute(segPhase, 1));
    this.synapseColors = new THREE.BufferAttribute(new Float32Array(segT.length * 3), 3);
    sg.setAttribute('aColor', this.synapseColors);
    this.synapseMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: SYNAPSE_VERT, fragmentShader: SYNAPSE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const lines = new THREE.LineSegments(sg, this.synapseMat);
    lines.frustumCulled = false;
    this.group.add(lines);
    this.setTheme(theme);
  }

  setTheme(theme: Theme) {
    const p = palette(theme);
    const a = new THREE.Color(p.fieldA), b = new THREE.Color(p.fieldB), c = new THREE.Color(p.fieldC);
    const col = new THREE.Color();
    const paint = (attr: THREE.BufferAttribute, mix: ArrayLike<number>) => {
      for (let i = 0; i < mix.length; i++) {
        const m = mix[i];
        col.copy(a).lerp(b, m);
        if (m > 0.8) col.lerp(c, (m - 0.8) * 2.5);
        attr.setXYZ(i, col.r, col.g, col.b);
      }
      attr.needsUpdate = true;
    };
    paint(this.neuronColors, this.mix);
    paint(this.synapseColors, this.synapseMix);
    const light = theme === 'light';
    this.uniforms.uLight.value = light ? 1 : 0;
    for (const m of [this.neuronMat, this.synapseMat]) {
      m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      m.needsUpdate = true;
    }
  }

  /** Start a shockwave rippling through the brain from `origin`. */
  wave(origin: THREE.Vector3, color: THREE.ColorRepresentation) {
    this.uniforms.uWaveOrigin.value.copy(origin);
    this.uniforms.uWaveColor.value.set(color);
    this.uniforms.uWaveTime.value = 0;
  }

  update(time: number, dt: number, activity: number) {
    this.uniforms.uTime.value = time;
    this.uniforms.uActivity.value = activity;
    const w = this.uniforms.uWaveTime;
    if (w.value >= 0) w.value = w.value + dt > 2.4 ? -1 : w.value + dt;
  }

  /** A random neuron position (for ambient sparks when the agent thinks). */
  randomNeuron(out: THREE.Vector3) {
    const i = Math.floor(Math.random() * (this.positions.length / 3));
    return out.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
  }
}
