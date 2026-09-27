import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Orchestrator } from '../src/agent/orchestrator.js';
import { EventBus, type BrainEvent } from '../src/events.js';
import { MemoryStore } from '../src/memory/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ScriptedLLM, testConfig, tmpDir } from './helpers.js';

const BUGGY = `export function applyDamage(hp, damage, armor) {
  return hp - damage + armor;
}
`;

function makeGameProject() {
  const root = tmpDir('brain-game-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'game', type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'combat.js'), BUGGY);
  fs.writeFileSync(
    path.join(root, 'combat.test.js'),
    `import test from 'node:test';
import assert from 'node:assert';
import { applyDamage } from './combat.js';
test('armor reduces damage', () => assert.strictEqual(applyDamage(100, 30, 10), 80));
test('armor never heals', () => assert.strictEqual(applyDamage(100, 5, 10), 100));
`,
  );
  return root;
}

function setup(llm: ScriptedLLM) {
  const dataDir = tmpDir('brain-data-');
  const config = testConfig(dataDir);
  const bus = new EventBus();
  const memory = new MemoryStore(dataDir);
  const orch = new Orchestrator({ config, llm, tools: new ToolRegistry(), memory, bus });
  const events: BrainEvent[] = [];
  bus.onEvent((e) => events.push(e));
  return { config, bus, memory, orch, events };
}

test('agent: analyze → plan → edit → test (fail) → fix → verify → report, then revert', async () => {
  const root = makeGameProject();
  const llm = new ScriptedLLM([
    () => ({ content: 'Analyzing the project.', toolCalls: [{ name: 'project_overview', arguments: {} }] }),
    () => ({
      toolCalls: [
        { name: 'update_plan', arguments: { steps: [{ title: 'Read combat code', status: 'in_progress' }, { title: 'Fix damage formula', status: 'pending' }, { title: 'Run tests', status: 'pending' }] } },
        { name: 'read_file', arguments: { path: 'combat.js' } },
      ],
    }),
    () => ({ toolCalls: [{ name: 'run_tests', arguments: {} }] }),
    // first attempt: wrong fix (still fails "armor never heals")
    () => ({ toolCalls: [{ name: 'edit_file', arguments: { path: 'combat.js', old_text: 'return hp - damage + armor;', new_text: 'return hp - (damage - armor);' } }] }),
    // model tries to finish without verifying → orchestrator must nudge
    () => ({ content: 'Fixed.' }),
    (req) => {
      assert.match(req.messages.at(-1)!.content, /not verified/);
      return { toolCalls: [{ name: 'run_tests', arguments: {} }] };
    },
    (req) => {
      assert.match(req.messages.at(-1)!.content, /TESTS FAILED/);
      return { toolCalls: [{ name: 'edit_file', arguments: { path: 'combat.js', old_text: 'return hp - (damage - armor);', new_text: 'return hp - Math.max(0, damage - armor);' } }] };
    },
    () => ({ toolCalls: [{ name: 'run_tests', arguments: {} }] }),
    (req) => {
      assert.match(req.messages.at(-1)!.content, /TESTS PASSED/);
      return {
        toolCalls: [
          { name: 'update_plan', arguments: { steps: [{ title: 'Read combat code', status: 'done' }, { title: 'Fix damage formula', status: 'done' }, { title: 'Run tests', status: 'done' }] } },
          { name: 'memory_save', arguments: { kind: 'decision', text: 'Armor reduces damage but can never heal: hp - max(0, damage - armor).', tags: ['combat'] } },
        ],
      };
    },
    () => ({ content: 'Fixed applyDamage: armor now reduces damage without ever healing. All tests pass.' }),
  ]);
  const { memory, orch, events } = setup(llm);
  const project = memory.addProject({ name: 'Game', path: root });

  const { runId, taskId } = orch.startRun({ prompt: 'Analizza il mio progetto e sistema il combat system.', projectId: project.id });
  await orch.wait(runId);

  const finished = events.find((e) => e.type === 'run.finished') as Extract<BrainEvent, { type: 'run.finished' }>;
  assert.equal(finished.status, 'done', finished.summary);
  assert.match(finished.summary, /All tests pass/);
  assert.deepEqual(finished.filesTouched, ['combat.js']);
  assert.match(fs.readFileSync(path.join(root, 'combat.js'), 'utf8'), /Math\.max\(0, damage - armor\)/);

  const task = memory.getTask(taskId)!;
  assert.equal(task.status, 'done');
  assert.ok(task.plan.every((s) => s.status === 'done'));
  assert.equal(task.history.length, 2);
  assert.equal(memory.searchMemories('combat armor', { projectId: project.id })[0].kind, 'decision');

  const toolRuns = events.filter((e) => e.type === 'tool.finished') as Extract<BrainEvent, { type: 'tool.finished' }>[];
  assert.deepEqual(toolRuns.filter((e) => e.tool === 'run_tests').map((e) => e.ok), [false, false, true]);
  assert.ok(events.some((e) => e.type === 'run.status' && e.phase === 'verifying'));
  assert.ok(events.some((e) => e.type === 'llm.token'));
  assert.ok(orch.runLog(runId).length > 5, 'run log persisted');

  // Undo everything the run changed.
  const restored = orch.revert(runId);
  assert.deepEqual(restored, ['combat.js']);
  assert.equal(fs.readFileSync(path.join(root, 'combat.js'), 'utf8'), BUGGY);
});

test('agent: risky action waits for approval; denial is reported back to the model', async () => {
  const root = makeGameProject();
  const llm = new ScriptedLLM([
    () => ({ toolCalls: [{ name: 'delete_file', arguments: { path: 'combat.test.js' } }] }),
    (req) => {
      assert.match(req.messages.at(-1)!.content, /DENIED/);
      return { content: 'Understood, I will keep the tests.' };
    },
  ]);
  const { bus, memory, orch, events } = setup(llm);
  bus.onEvent((e) => {
    if (e.type === 'approval.requested') {
      assert.equal(e.danger, true);
      setTimeout(() => orch.approvals.resolve(e.id, false), 10);
    }
  });
  const project = memory.addProject({ name: 'Game', path: root });
  const { runId } = orch.startRun({ prompt: 'delete the tests', projectId: project.id });
  await orch.wait(runId);
  assert.ok(fs.existsSync(path.join(root, 'combat.test.js')));
  assert.ok(events.some((e) => e.type === 'approval.resolved' && !e.approved));
  assert.equal((events.find((e) => e.type === 'run.finished') as any).status, 'done');
});

test('agent: sandbox, unknown tools and bad args become recoverable errors', async () => {
  const root = makeGameProject();
  const llm = new ScriptedLLM([
    () => ({
      toolCalls: [
        { name: 'read_file', arguments: { path: '../../etc/passwd' } },
        { name: 'teleport', arguments: {} },
        { name: 'edit_file', arguments: { path: 'combat.js' } },
      ],
    }),
    (req) => {
      const results = req.messages.filter((m) => m.role === 'tool').map((m) => m.content);
      assert.match(results[0], /outside the project root/);
      assert.match(results[1], /Unknown tool/);
      assert.match(results[2], /Missing required argument/);
      return { content: 'done' };
    },
  ]);
  const { memory, orch, events } = setup(llm);
  const project = memory.addProject({ name: 'Game', path: root });
  const { runId } = orch.startRun({ prompt: 'x', projectId: project.id });
  await orch.wait(runId);
  assert.equal((events.find((e) => e.type === 'run.finished') as any).status, 'done');
});

test('agent: cancelling kills a running command promptly', async () => {
  const root = makeGameProject();
  const llm = new ScriptedLLM([() => ({ toolCalls: [{ name: 'run_tests', arguments: { command: 'node -e "setTimeout(()=>{}, 60000)"' } }] })]);
  const { bus, memory, orch, events } = setup(llm);
  bus.onEvent((e) => {
    if (e.type === 'approval.requested') orch.approvals.resolve(e.id, true);
    if (e.type === 'run.status' && e.phase === 'tool') setTimeout(() => orch.cancel(e.runId), 300);
  });
  const project = memory.addProject({ name: 'Game', path: root });
  const t0 = Date.now();
  const { runId } = orch.startRun({ prompt: 'run forever', projectId: project.id });
  await orch.wait(runId);
  assert.ok(Date.now() - t0 < 10_000, 'cancel should be fast');
  assert.equal((events.find((e) => e.type === 'run.finished') as any).status, 'cancelled');
});

test('agent: only one run per project at a time', async () => {
  const root = makeGameProject();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const llm = new ScriptedLLM([() => ({ content: 'ok' })]);
  const slow = { ...llm, id: 'slow', model: 'slow', contextTokens: 8000, health: llm.health, listModels: llm.listModels, chat: async (req: any) => (await gate, llm.chat(req)) };
  const { memory, orch } = setup(slow as any);
  const project = memory.addProject({ name: 'Game', path: root });
  const { runId } = orch.startRun({ prompt: 'a', projectId: project.id });
  assert.throws(() => orch.startRun({ prompt: 'b', projectId: project.id }), /already working/);
  release();
  await orch.wait(runId);
});
