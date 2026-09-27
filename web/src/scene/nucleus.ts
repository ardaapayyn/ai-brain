import * as THREE from 'three';
import type { Theme } from './palette';

const RING_VERT = /* glsl */ `
  attribute float aU;
  varying float vU;
  void main() { vU = aU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const RING_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uActivity;
  uniform vec3 uColor;
  uniform float uLight;
  varying float vU;
  void main() {
    float head = fract(vU - uTime * uSpeed);
    float comet = pow(head, 10.0) * 1.2 + pow(head, 2.0) * 0.18;
    float a = (0.1 + comet) * (0.6 + uActivity * 0.8);
    gl_FragColor = vec4(mix(uColor, vec3(1.0), comet * 0.5 * (1.0 - uLight)), min(1.0, a * mix(1.0, 1.4, uLight)));
  }
`;

const ORBIT_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uActivity;
  uniform float uPixelRatio;
  attribute vec4 aOrbit; // radius, speed, phase, tilt
  varying float vA;
  void main() {
    float ang = aOrbit.z + uTime * aOrbit.y * (1.0 + uActivity * 2.5);
    vec3 p = vec3(cos(ang), 0.0, sin(ang)) * aOrbit.x;
    float t = aOrbit.w;
    p = vec3(p.x, p.z * sin(t), p.z * cos(t));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vA = 0.35 + 0.65 * (0.5 + 0.5 * sin(ang * 3.0 + aOrbit.z * 10.0));
    gl_PointSize = (1.6 + aOrbit.x * 0.05) * uPixelRatio * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const ORBIT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    gl_FragColor = vec4(uColor, pow(1.0 - d, 2.0) * vA);
  }
`;

/** Spinning energy rings and orbiting particles around the brain core. */
export class Nucleus {
  readonly group = new THREE.Group();
  private rings: { mesh: THREE.LineLoop; mat: THREE.ShaderMaterial; axis: THREE.Vector3; spin: number }[] = [];
  private orbitMat: THREE.ShaderMaterial;
  private activity = 0;

  constructor(pixelRatio: number) {
    const specs = [
      { r: 15, tilt: new THREE.Euler(1.2, 0.2, 0), speed: 0.35, color: 0xa78bfa, spin: 0.25 },
      { r: 20, tilt: new THREE.Euler(0.3, 0.9, 0.5), speed: -0.25, color: 0x67e8f9, spin: -0.18 },
      { r: 26, tilt: new THREE.Euler(-0.6, 0.1, 1.1), speed: 0.18, color: 0xf0abfc, spin: 0.12 },
    ];
    for (const s of specs) {
      const n = 160;
      const pos = new Float32Array(n * 3);
      const u = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pos.set([Math.cos(a) * s.r, 0, Math.sin(a) * s.r], i * 3);
        u[i] = i / n;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aU', new THREE.BufferAttribute(u, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uSpeed: { value: s.speed }, uActivity: { value: 0 }, uColor: { value: new THREE.Color(s.color) }, uLight: { value: 0 } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.LineLoop(g, mat);
      mesh.rotation.copy(s.tilt);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, axis: new THREE.Vector3(0, 1, 0), spin: s.spin });
    }

    const count = 140;
    const orbit = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) orbit.set([9 + Math.random() * 26, (0.2 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1), Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI], i * 4);
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    og.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
    this.orbitMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uActivity: { value: 0 }, uPixelRatio: { value: pixelRatio }, uColor: { value: new THREE.Color(0xe9e4ff) } },
      vertexShader: ORBIT_VERT,
      fragmentShader: ORBIT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(og, this.orbitMat);
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  setTheme(theme: Theme) {
    const light = theme === 'light';
    const colors = light ? [0x6d28d9, 0x0e7490, 0xa21caf] : [0xa78bfa, 0x67e8f9, 0xf0abfc];
    this.rings.forEach((r, i) => {
      r.mat.uniforms.uColor.value.set(colors[i]);
      r.mat.uniforms.uLight.value = light ? 1 : 0;
      r.mat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      r.mat.needsUpdate = true;
    });
    this.orbitMat.uniforms.uColor.value.set(light ? 0x4c1d95 : 0xe9e4ff);
    this.orbitMat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.orbitMat.needsUpdate = true;
  }

  update(time: number, dt: number, activity: number, position?: THREE.Vector3) {
    this.activity += (activity - this.activity) * Math.min(1, dt * 2);
    if (position) this.group.position.copy(position);
    for (const r of this.rings) {
      r.mat.uniforms.uTime.value = time;
      r.mat.uniforms.uActivity.value = this.activity;
      r.mesh.rotateOnAxis(r.axis, r.spin * dt * (1 + this.activity * 3));
    }
    this.orbitMat.uniforms.uTime.value = time;
    this.orbitMat.uniforms.uActivity.value = this.activity;
    const s = 1 + this.activity * 0.12 + Math.sin(time * 1.4) * 0.02;
    this.group.scale.setScalar(s);
  }
}

const DUST_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aPhase;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vA = 0.25 + 0.75 * (0.5 + 0.5 * sin(uTime * 0.4 + aPhase * 50.0));
    gl_PointSize = (1.0 + aPhase * 1.6) * uPixelRatio * (600.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const DUST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    gl_FragColor = vec4(uColor, pow(1.0 - d, 2.0) * vA * uOpacity);
  }
`;

/** Far-away drifting dust: gives the scene depth and parallax. */
export class Dust {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(count: number, pixelRatio: number) {
    const pos = new Float32Array(count * 3);
    const ph = new Float32Array(count);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.randomDirection().multiplyScalar(600 + Math.pow(Math.random(), 0.7) * 1800);
      pos.set([v.x, v.y, v.z], i * 3);
      ph[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio }, uColor: { value: new THREE.Color(0x9f95d8) }, uOpacity: { value: 0.55 } },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  setTheme(theme: Theme) {
    const light = theme === 'light';
    this.mat.uniforms.uColor.value.set(light ? 0x6b5fb0 : 0x9f95d8);
    this.mat.uniforms.uOpacity.value = light ? 0.35 : 0.55;
    this.mat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.mat.needsUpdate = true;
  }

  update(time: number) {
    this.mat.uniforms.uTime.value = time;
    this.points.rotation.y = time * 0.006;
    this.points.rotation.x = Math.sin(time * 0.01) * 0.05;
  }
}
