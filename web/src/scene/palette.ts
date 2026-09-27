import * as THREE from 'three';
import type { GraphNode } from '../types';

export type Theme = 'dark' | 'light';

const DARK = {
  background: 0x000000,
  core: 0xf5f3ff,
  tool: 0x5eead4,
  project: 0xa78bfa,
  module: 0x60a5fa,
  task: 0xf472b6,
  taskRunning: 0xfde047,
  taskDone: 0x4ade80,
  taskFailed: 0xf87171,
  memory: { decision: 0xfbbf24, idea: 0xf472b6, fact: 0x67e8f9, note: 0xc4b5fd, preference: 0x86efac } as Record<string, number>,
  fieldA: 0x6d5dfc,
  fieldB: 0x22d3ee,
  fieldC: 0xf0abfc,
  pulse: 0xffffff,
  ok: 0x4ade80,
  fail: 0xf87171,
};

const LIGHT: typeof DARK = {
  background: 0xf3f4f8,
  core: 0x1e1b4b,
  tool: 0x0d9488,
  project: 0x6d28d9,
  module: 0x2563eb,
  task: 0xdb2777,
  taskRunning: 0xd97706,
  taskDone: 0x16a34a,
  taskFailed: 0xdc2626,
  memory: { decision: 0xd97706, idea: 0xdb2777, fact: 0x0891b2, note: 0x7c3aed, preference: 0x16a34a },
  fieldA: 0x4338ca,
  fieldB: 0x0e7490,
  fieldC: 0xa21caf,
  pulse: 0x312e81,
  ok: 0x16a34a,
  fail: 0xdc2626,
};

export const palette = (theme: Theme) => (theme === 'dark' ? DARK : LIGHT);

export function nodeColor(n: GraphNode, theme: Theme): THREE.Color {
  const p = palette(theme);
  switch (n.type) {
    case 'core':
      return new THREE.Color(p.core);
    case 'tool':
      return new THREE.Color(p.tool);
    case 'project':
      return new THREE.Color(p.project);
    case 'module':
      return new THREE.Color(p.module);
    case 'task':
      return new THREE.Color(
        n.status === 'running' ? p.taskRunning : n.status === 'done' ? p.taskDone : n.status === 'failed' ? p.taskFailed : p.task,
      );
    case 'memory':
      return new THREE.Color(p.memory[n.kind ?? 'note'] ?? p.memory.note);
  }
}
