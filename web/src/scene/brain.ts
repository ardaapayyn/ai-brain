import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Graph } from '../types';
import { NeuralField } from './field';
import { GraphLayer } from './graph';
import { palette, type Theme } from './palette';
import { PulseLayer } from './pulses';

const HOME_POS = new THREE.Vector3(40, 70, 420);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);

interface Flight {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  t: number;
  duration: number;
  follow?: string;
}

/** Owns the WebGL scene: neural field, semantic graph, pulses, camera choreography. */
export class BrainScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly graph: GraphLayer;
  readonly pulses: PulseLayer;
  private scene = new THREE.Scene();
  private field: NeuralField;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private clock = new THREE.Clock();
  private flight?: Flight;
  private activity = 0;
  private targetActivity = 0;
  private lastInteraction = 0;
  private theme: Theme;
  private pointer = { x: -1, y: -1, down: false, moved: 0 };
  onSelect?: (id: string | undefined) => void;
  onHover?: (id: string | undefined) => void;

  constructor(private canvas: HTMLCanvasElement, labels: HTMLElement, theme: Theme) {
    this.theme = theme;
    const pr = Math.min(window.devicePixelRatio, 2);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 6000);
    this.camera.position.copy(HOME_POS);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.6;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 1400;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.25;
    this.controls.target.copy(HOME_TARGET);
    this.controls.addEventListener('start', () => {
      this.flight = undefined;
      this.lastInteraction = performance.now();
      this.controls.autoRotate = false;
    });

    const mobile = window.innerWidth < 800;
    this.field = new NeuralField(mobile ? 5000 : 12000, pr, theme);
    this.graph = new GraphLayer(labels, pr, theme);
    this.pulses = new PulseLayer(pr);
    this.scene.add(this.field.group, this.graph.group, this.pulses.points);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.55, 0.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.setTheme(theme);
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    const bg = new THREE.Color(palette(theme).background);
    this.scene.background = bg;
    this.scene.fog = new THREE.FogExp2(bg, theme === 'dark' ? 0.0009 : 0.0006);
    this.bloom.strength = theme === 'dark' ? 0.85 : 0.12;
    this.bloom.threshold = theme === 'dark' ? 0.05 : 0.85;
    this.field.setTheme(theme);
    this.graph.setTheme(theme);
    this.pulses.setLight(theme === 'light');
  }

  setGraph(g: Graph) {
    this.graph.setGraph(g);
  }

  /** 0 = idle … 1 = agent working hard. Drives neuron twinkle and synapse firing. */
  setActivity(level: number) {
    this.targetActivity = THREE.MathUtils.clamp(level, 0, 1);
  }
  bumpActivity(amount = 0.15) {
    this.activity = Math.min(1, this.activity + amount);
  }

  /** Smooth cinematic flight to a node. */
  flyTo(id: string, distance?: number) {
    const v = this.graph.get(id);
    if (!v) return;
    const d = distance ?? ({ core: 190, tool: 110, project: 150, module: 70, task: 70, memory: 55 } as const)[v.node.type];
    const target = v.target.clone();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (v.node.type === 'project' || v.node.type === 'module' || v.node.type === 'task') {
      // look at the cluster from outside the brain, slightly from the side so the core
      // doesn't sit right behind it
      const out = target.clone().normalize();
      const side = new THREE.Vector3(0, 1, 0).cross(out).normalize();
      dir.lerp(out.add(side.multiplyScalar(0.7)).normalize(), 0.7).normalize();
    }
    this.startFlight(target.clone().add(dir.multiplyScalar(d)), target, 1.4, id);
  }

  home() {
    this.startFlight(HOME_POS.clone(), HOME_TARGET.clone(), 1.6);
    this.graph.selected = undefined;
  }

  private startFlight(toPos: THREE.Vector3, toTarget: THREE.Vector3, duration: number, follow?: string) {
    this.controls.autoRotate = false;
    this.lastInteraction = performance.now();
    this.flight = { fromPos: this.camera.position.clone(), toPos, fromTarget: this.controls.target.clone(), toTarget, t: 0, duration, follow };
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
      if (this.pointer.moved > 6) return; // it was a drag
      const id = this.graph.pick(e.clientX, e.clientY, this.camera);
      this.graph.selected = id;
      if (id) this.flyTo(id);
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

  /** Ambient sparks inside the field while the model is thinking. */
  spark(color?: THREE.ColorRepresentation) {
    const a = this.field.randomNeuron(new THREE.Vector3());
    const b = this.field.randomNeuron(new THREE.Vector3());
    if (a.distanceTo(b) > 140) b.lerp(a, 0.6);
    this.pulses.fire(a, b, { color: color ?? palette(this.theme).fieldB, duration: 0.5 + Math.random() * 0.5, size: 4, arc: 0.1 });
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
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
      if (f.t >= 1) this.flight = undefined;
    } else if (!this.controls.autoRotate && performance.now() - this.lastInteraction > 25_000 && !this.graph.selected) {
      this.controls.autoRotate = true; // drift again after a while of inactivity
    }
    this.controls.update();

    this.activity += (this.targetActivity - this.activity) * Math.min(1, dt * 1.5);
    this.field.update(time, this.activity);
    this.pulses.update(dt);
    this.graph.update(time, dt, this.camera, window.innerWidth, window.innerHeight);

    const hovered = this.pointer.x >= 0 && !this.pointer.down ? this.graph.pick(this.pointer.x, this.pointer.y, this.camera) : undefined;
    if (hovered !== this.graph.hovered) {
      this.graph.hovered = hovered;
      this.canvas.style.cursor = hovered ? 'pointer' : 'grab';
      this.onHover?.(hovered);
    }
    this.composer.render();
  }
}
