import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { QUALITY, type Quality } from '../prefs';
import type { Graph } from '../types';
import { NeuralField } from './field';
import { GraphLayer } from './graph';
import { Dust, Nucleus } from './nucleus';
import { palette, type Theme } from './palette';
import { PulseLayer } from './pulses';

const HOME_POS = new THREE.Vector3(40, 70, 420);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);
const INTRO_POS = new THREE.Vector3(-260, 380, 1500);

/** Cinematic finishing pass: vignette, film grain, subtle chromatic aberration at the edges. */
const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.55 }, uGrain: { value: 0.035 }, uAberration: { value: 0.006 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; uniform float uAberration;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);
      vec2 off = c * uAberration * r * 2.0;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= mix(1.0, smoothstep(0.95, 0.25, r), uVignette);
      float n = fract(sin(dot(vUv * 913.0 + fract(uTime) * 71.0, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

interface Flight {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  t: number;
  duration: number;
  follow?: string;
  ease: (t: number) => number;
  /** Intro flights run on wall-clock time so slow GPUs don't stretch the sequence. */
  wallClock?: number;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

export interface SceneOptions {
  theme: Theme;
  quality: Quality;
  autoRotate: boolean;
}

/** Owns the WebGL scene: neural field, nucleus, semantic graph, pulses, camera choreography, post FX. */
export class BrainScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly graph: GraphLayer;
  readonly pulses: PulseLayer;
  private scene = new THREE.Scene();
  private field: NeuralField;
  private nucleus: Nucleus;
  private dust: Dust;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private finish?: ShaderPass;
  private bloomScale: number;
  private clock = new THREE.Clock();
  private flight?: Flight;
  private assemble?: { start: number; duration: number; resolve: () => void };
  private activity = 0;
  private targetActivity = 0;
  private lastInteraction = 0;
  private theme: Theme;
  private autoRotate: boolean;
  private pointer = { x: -1, y: -1, down: false, moved: 0 };
  onSelect?: (id: string | undefined) => void;
  onHover?: (id: string | undefined, x: number, y: number) => void;

  constructor(private canvas: HTMLCanvasElement, labels: HTMLElement, opts: SceneOptions) {
    this.theme = opts.theme;
    this.autoRotate = opts.autoRotate;
    const q = QUALITY[opts.quality];
    this.bloomScale = q.bloom;
    const pr = Math.min(window.devicePixelRatio, q.pixelRatio);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 8000);
    this.camera.position.copy(HOME_POS);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.6;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 1600;
    this.controls.autoRotate = opts.autoRotate;
    this.controls.autoRotateSpeed = 0.22;
    this.controls.target.copy(HOME_TARGET);
    this.controls.addEventListener('start', () => {
      this.flight = undefined;
      this.lastInteraction = performance.now();
      this.controls.autoRotate = false;
    });

    this.field = new NeuralField(window.innerWidth < 800 ? Math.min(q.neurons, 5000) : q.neurons, pr, opts.theme);
    this.nucleus = new Nucleus(pr);
    this.dust = new Dust(q.dust, pr);
    this.graph = new GraphLayer(labels, pr, opts.theme);
    this.pulses = new PulseLayer(pr);
    this.scene.add(this.dust.points, this.field.group, this.nucleus.group, this.graph.group, this.pulses.points);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.55, 0.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    if (q.post) {
      this.finish = new ShaderPass(FinishShader);
      this.composer.addPass(this.finish);
    }

    this.setTheme(opts.theme);
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    const bg = new THREE.Color(palette(theme).background);
    this.scene.background = bg;
    this.bloom.strength = (theme === 'dark' ? 0.78 : 0.12) * this.bloomScale;
    this.bloom.threshold = theme === 'dark' ? 0.05 : 0.85;
    if (this.finish) {
      const u = this.finish.uniforms as any;
      u.uVignette.value = theme === 'dark' ? 0.6 : 0.12;
      u.uGrain.value = theme === 'dark' ? 0.032 : 0.018;
      u.uAberration.value = theme === 'dark' ? 0.006 : 0;
    }
    this.field.setTheme(theme);
    this.nucleus.setTheme(theme);
    this.dust.setTheme(theme);
    this.graph.setTheme(theme);
    this.pulses.setLight(theme === 'light');
  }

  setAutoRotate(on: boolean) {
    this.autoRotate = on;
    this.controls.autoRotate = on;
  }

  setGraph(g: Graph) {
    this.graph.setGraph(g);
  }

  /** 0 = idle … 1 = agent working hard. Drives neuron twinkle, synapse firing and the nucleus. */
  setActivity(level: number) {
    this.targetActivity = THREE.MathUtils.clamp(level, 0, 1);
  }
  bumpActivity(amount = 0.15) {
    this.activity = Math.min(1, this.activity + amount);
  }
  get activityLevel() {
    return this.activity;
  }

  /** Boot sequence: neurons fly in and assemble the brain while the camera glides home. */
  playIntro(duration = 3.6): Promise<void> {
    this.field.uniforms.uAssemble.value = 0;
    this.camera.position.copy(INTRO_POS);
    this.controls.target.copy(HOME_TARGET);
    this.flight = { fromPos: INTRO_POS.clone(), toPos: HOME_POS.clone(), fromTarget: HOME_TARGET.clone(), toTarget: HOME_TARGET.clone(), t: 0, duration: duration * 1.05, ease: easeOutExpo, wallClock: performance.now() };
    this.graph.group.visible = false;
    return new Promise((resolve) => (this.assemble = { start: performance.now(), duration, resolve }));
  }

  skipIntro() {
    if (this.assemble) this.assemble.start = performance.now() - this.assemble.duration * 1000;
    if (this.flight?.wallClock) this.flight.wallClock = performance.now() - this.flight.duration * 1000;
  }

  /** Shockwave through the neural field from a node (or the core). */
  wave(id: string, color: THREE.ColorRepresentation) {
    const p = this.graph.position(id) ?? HOME_TARGET;
    this.field.wave(p, color);
  }

  flyTo(id: string, distance?: number) {
    const v = this.graph.get(id);
    if (!v) return;
    const d = distance ?? ({ core: 190, tool: 110, project: 150, module: 70, task: 70, memory: 55 } as const)[v.node.type];
    const target = v.target.clone();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (v.node.type === 'project') {
      // three-quarter view from outside the brain: the core sits beside the cluster, not behind it
      const out = target.clone().normalize();
      const side = new THREE.Vector3(0, 1, 0).cross(out).normalize();
      dir.copy(out.multiplyScalar(0.55).add(side.multiplyScalar(0.8)).add(new THREE.Vector3(0, 0.35, 0))).normalize();
    } else if (v.node.type === 'module' || v.node.type === 'task') {
      const out = target.clone().normalize();
      const side = new THREE.Vector3(0, 1, 0).cross(out).normalize();
      dir.lerp(out.add(side.multiplyScalar(0.7)).normalize(), 0.7).normalize();
    }
    this.startFlight(target.clone().add(dir.multiplyScalar(d)), target, 1.5, id);
  }

  home() {
    this.startFlight(HOME_POS.clone(), HOME_TARGET.clone(), 1.7);
    this.graph.selected = undefined;
  }

  private startFlight(toPos: THREE.Vector3, toTarget: THREE.Vector3, duration: number, follow?: string) {
    this.controls.autoRotate = false;
    this.lastInteraction = performance.now();
    this.flight = { fromPos: this.camera.position.clone(), toPos, fromTarget: this.controls.target.clone(), toTarget, t: 0, duration, follow, ease: easeInOutCubic };
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      if (this.pointer.down) this.pointer.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    });
    c.addEventListener('pointerdown', () => {
      this.pointer.down = true;
      this.pointer.moved = 0;
    });
    c.addEventListener('pointerup', (e) => {
      this.pointer.down = false;
      if (this.pointer.moved > 6) return;
      const id = this.graph.pick(e.clientX, e.clientY, this.camera);
      if (!id) return;
      this.graph.selected = id;
      this.flyTo(id);
      this.onSelect?.(id);
    });
    c.addEventListener('dblclick', (e) => {
      if (!this.graph.pick(e.clientX, e.clientY, this.camera)) {
        this.home();
        this.onSelect?.(undefined);
      }
    });
    c.addEventListener('pointerleave', () => {
      this.pointer.x = this.pointer.y = -1;
      if (this.graph.hovered) {
        this.graph.hovered = undefined;
        this.onHover?.(undefined, 0, 0);
      }
    });
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  }

  spark(color?: THREE.ColorRepresentation) {
    const a = this.field.randomNeuron(new THREE.Vector3());
    const b = this.field.randomNeuron(new THREE.Vector3());
    if (a.distanceTo(b) > 140) b.lerp(a, 0.6);
    this.pulses.fire(a, b, { color: color ?? palette(this.theme).fieldB, duration: 0.5 + Math.random() * 0.5, size: 4, arc: 0.1 });
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    if (this.assemble) {
      const a = this.assemble;
      const p = Math.min(1, (performance.now() - a.start) / 1000 / a.duration);
      this.field.uniforms.uAssemble.value = p;
      if (p > 0.6) this.graph.group.visible = true;
      if (p >= 1) {
        this.assemble = undefined;
        this.graph.group.visible = true;
        a.resolve();
      }
    }

    if (this.flight) {
      const f = this.flight;
      f.t = f.wallClock !== undefined ? Math.min(1, (performance.now() - f.wallClock) / 1000 / f.duration) : Math.min(1, f.t + dt / f.duration);
      const e = f.ease(f.t);
      if (f.follow) {
        const live = this.graph.get(f.follow);
        if (live) {
          const delta = live.pos.clone().sub(f.toTarget);
          f.toTarget.add(delta);
          f.toPos.add(delta);
        }
      }
      this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
      if (f.t >= 1) {
        this.flight = undefined;
        if (f.ease === easeOutExpo) this.controls.autoRotate = this.autoRotate;
      }
    } else if (this.autoRotate && !this.controls.autoRotate && performance.now() - this.lastInteraction > 25_000 && !this.graph.selected) {
      this.controls.autoRotate = true;
    }
    this.controls.update();

    this.activity += (this.targetActivity - this.activity) * Math.min(1, dt * 1.5);
    this.field.update(time, dt, this.activity);
    this.nucleus.update(time, dt, this.activity, this.graph.get('core')?.pos);
    this.dust.update(time);
    this.pulses.update(dt);
    this.graph.update(time, dt, this.camera, window.innerWidth, window.innerHeight);
    if (this.finish) (this.finish.uniforms as any).uTime.value = time;

    const hovered = this.pointer.x >= 0 && !this.pointer.down ? this.graph.pick(this.pointer.x, this.pointer.y, this.camera) : undefined;
    if (hovered !== this.graph.hovered) {
      this.graph.hovered = hovered;
      this.canvas.style.cursor = hovered ? 'pointer' : 'grab';
    }
    if (hovered || this.onHover) this.onHover?.(hovered, this.pointer.x, this.pointer.y);
    this.composer.render();
  }
}
