import * as THREE from 'three';
import { palette, type Theme } from './palette';

/**
 * The ambient "living brain": thousands of neurons shaped like two hemispheres + cerebellum,
 * connected by synapses. Everything animates on the GPU — breathing, twinkling, and impulses
 * that race along synapses (more of them when the agent is working).
 */

const NEURON_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uActivity;
  uniform float uPixelRatio;
  uniform float uLight;
  attribute float aPhase;
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vTwinkle;
  varying float vNear;
  void main() {
    vec3 p = position;
    float breathe = 1.0 + 0.012 * sin(uTime * 0.6);
    p *= breathe;
    p += normalize(p + 0.001) * sin(uTime * (0.6 + aPhase * 0.4) + aPhase * 40.0) * 0.9;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float speed = 1.2 + uActivity * 5.0;
    vTwinkle = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * speed + aPhase * 97.0), 6.0);
    vColor = aColor;
    gl_PointSize = aSize * uPixelRatio * (320.0 / -mv.z) * (1.0 + uActivity * 0.35 * vTwinkle) * mix(1.0, 2.8, uLight);
    vNear = smoothstep(18.0, 110.0, -mv.z); // fade neurons right in front of the camera
    gl_Position = projectionMatrix * mv;
  }
`;

const NEURON_FRAG = /* glsl */ `
  uniform float uActivity;
  uniform float uLight;
  varying vec3 vColor;
  varying float vTwinkle;
  varying float vNear;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float a = pow(core, 1.8) * vTwinkle * (0.55 + uActivity * 0.45) * vNear;
    gl_FragColor = vec4(vColor * (1.0 + (1.0 - uLight) * 0.4 * vTwinkle), min(1.0, a * mix(0.5, 2.6, uLight)));
  }
`;

const SYNAPSE_VERT = /* glsl */ `
  uniform float uTime;
  attribute float aT;
  attribute float aPhase;
  attribute vec3 aColor;
  varying float vT;
  varying float vPhase;
  varying vec3 vColor;
  void main() {
    vec3 p = position * (1.0 + 0.012 * sin(uTime * 0.6));
    vT = aT; vPhase = aPhase; vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const SYNAPSE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uActivity;
  uniform float uLight;
  varying float vT;
  varying float vPhase;
  varying vec3 vColor;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    float speed = 0.35 + uActivity * 1.4;
    float cycle = uTime * speed + vPhase * 17.0;
    float idx = floor(cycle);
    float rate = 0.10 + uActivity * 0.55;          // fraction of synapses firing per cycle
    float fires = step(hash(idx * 1.7 + vPhase * 91.0), rate);
    float head = fract(cycle);
    float pulse = fires * smoothstep(0.14, 0.0, abs(head - vT));
    float base = mix(0.03, 0.3, uLight) + uActivity * 0.03;
    float a = base + pulse * 0.65;
    vec3 col = mix(vColor, vec3(1.0), pulse * 0.6 * (1.0 - uLight));
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

/** Sample a point on/in a stylised brain: 2 folded hemispheres, cerebellum, brain stem. */
function brainPoint(r: () => number, out: THREE.Vector3) {
  const R = BRAIN_RADIUS;
  const pick = r();
  if (pick < 0.84) {
    const side = r() < 0.5 ? -1 : 1;
    const u = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    while (u.lengthSq() > 1 || u.lengthSq() < 1e-4) u.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    u.normalize();
    if (u.x * side < 0) u.x *= 0.18; // flatten the medial wall
    const theta = Math.atan2(u.z, u.y);
    const phi = Math.acos(THREE.MathUtils.clamp(u.x, -1, 1));
    const sulci = 1 + 0.055 * Math.sin(theta * 9 + phi * 4) * Math.sin(phi * 7 + theta * 2);
    const shell = r() < 0.8 ? 0.86 + 0.14 * Math.sqrt(r()) : Math.cbrt(r()) * 0.85;
    const rr = R * shell * sulci;
    out.set(u.x * rr * 0.62 + side * R * 0.07, u.y * rr * 0.78 + R * 0.05, u.z * rr * 1.0);
  } else if (pick < 0.95) {
    // cerebellum
    const u = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    const rr = R * 0.36 * (0.75 + 0.25 * Math.sqrt(r())) * (1 + 0.08 * Math.sin(u.y * 30));
    out.set(u.x * rr * 1.25, u.y * rr * 0.6 - R * 0.52, u.z * rr * 0.8 - R * 0.62);
  } else {
    // brain stem
    const a = r() * Math.PI * 2;
    const rr = R * 0.1 * Math.sqrt(r());
    const h = r();
    out.set(Math.cos(a) * rr, -R * 0.35 - h * R * 0.55, Math.sin(a) * rr - R * 0.25 - h * R * 0.12);
  }
  return out;
}

export class NeuralField {
  readonly group = new THREE.Group();
  private neuronMat: THREE.ShaderMaterial;
  private synapseMat: THREE.ShaderMaterial;
  private neuronColors: THREE.BufferAttribute;
  private synapseColors: THREE.BufferAttribute;
  private positions: Float32Array;
  private mix: Float32Array;

  constructor(count: number, pixelRatio: number, theme: Theme) {
    const seed = { s: 1337 };
    const r = () => rand(seed);
    this.positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const sizes = new Float32Array(count);
    this.mix = new Float32Array(count);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      brainPoint(r, v);
      this.positions.set([v.x, v.y, v.z], i * 3);
      phases[i] = r();
      sizes[i] = 1.0 + Math.pow(r(), 7) * 4.5;
      this.mix[i] = THREE.MathUtils.clamp(0.5 + v.x / (BRAIN_RADIUS * 1.3) + (r() - 0.5) * 0.35, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.neuronColors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    g.setAttribute('aColor', this.neuronColors);

    const uniforms = {
      uTime: { value: 0 },
      uActivity: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uLight: { value: 0 },
    };
    this.neuronMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: NEURON_VERT,
      fragmentShader: NEURON_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(g, this.neuronMat);
    points.frustumCulled = false;
    this.group.add(points);

    // Synapses: connect a subset of neurons to their nearest neighbours (spatial hash).
    const cell = 16;
    const grid = new Map<string, number[]>();
    const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let i = 0; i < count; i++) {
      const k = key(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
    const segs: number[] = [];
    const segT: number[] = [];
    const segPhase: number[] = [];
    const segMix: number[] = [];
    const sources = Math.min(count, Math.floor(count * 0.45));
    for (let s = 0; s < sources; s++) {
      const i = Math.floor(r() * count);
      const px = this.positions[i * 3], py = this.positions[i * 3 + 1], pz = this.positions[i * 3 + 2];
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
      const near: { j: number; d: number }[] = [];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              if (j === i) continue;
              const d = Math.hypot(this.positions[j * 3] - px, this.positions[j * 3 + 1] - py, this.positions[j * 3 + 2] - pz);
              if (d > 3 && d < cell * 1.3) near.push({ j, d });
            }
          }
      near.sort((a, b) => a.d - b.d);
      const phase = r();
      for (const { j } of near.slice(0, 2)) {
        segs.push(px, py, pz, this.positions[j * 3], this.positions[j * 3 + 1], this.positions[j * 3 + 2]);
        segT.push(0, 1);
        segPhase.push(phase, phase);
        segMix.push(this.mix[i], this.mix[j]);
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    sg.setAttribute('aT', new THREE.Float32BufferAttribute(segT, 1));
    sg.setAttribute('aPhase', new THREE.Float32BufferAttribute(segPhase, 1));
    this.synapseColors = new THREE.BufferAttribute(new Float32Array(segT.length * 3), 3);
    sg.setAttribute('aColor', this.synapseColors);
    (sg as any).userData.mix = segMix;
    this.synapseMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SYNAPSE_VERT,
      fragmentShader: SYNAPSE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
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
    paint(this.synapseColors, (this.group.children[1] as THREE.LineSegments).geometry.userData.mix);
    const light = theme === 'light';
    this.neuronMat.uniforms.uLight.value = light ? 1 : 0;
    for (const m of [this.neuronMat, this.synapseMat]) {
      m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      m.needsUpdate = true;
    }
  }

  update(time: number, activity: number) {
    this.neuronMat.uniforms.uTime.value = time;
    this.neuronMat.uniforms.uActivity.value = activity;
  }

  /** A random neuron position (for ambient sparks when the agent thinks). */
  randomNeuron(out: THREE.Vector3) {
    const i = Math.floor(Math.random() * (this.positions.length / 3));
    return out.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
  }
}
