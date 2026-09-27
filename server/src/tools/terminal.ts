import fs from 'node:fs';
import { classifyCommand, formatResult, runCommand } from './process.js';
import { num, str, ToolArgError, type Tool } from './types.js';

export const runCommandTool: Tool = {
  name: 'run_command',
  category: 'terminal',
  description:
    'Run a shell command in the project (build, lint, scripts, package managers, git read commands…). Non-interactive; output is returned when it exits. Read-only/build/test commands run directly; anything else asks the user first.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      cwd: { type: 'string', description: 'Working directory relative to project root (default ".")' },
      timeout_sec: { type: 'integer', description: 'Timeout in seconds (default from config, max 1800)' },
    },
    required: ['command'],
  },
  risk: 'shell',
  isRisky: (a) => classifyCommand(String(a.command ?? '')).risky,
  isDangerous: (a) => classifyCommand(String(a.command ?? '')).dangerous,
  summarize: (a) => `$ ${a.command}`,
  approvalDetail: (a) => `${a.cwd ? `cd ${a.cwd}\n` : ''}$ ${a.command}`,
  async execute(a, ctx) {
    const command = str(a, 'command');
    const cwd = ctx.workspace.resolve(a.cwd);
    if (!fs.existsSync(cwd)) throw new ToolArgError(`cwd does not exist: ${a.cwd}`);
    const timeoutMs = Math.min(num(a, 'timeout_sec', ctx.config.shell.timeoutMs / 1000), 1800) * 1000;
    const r = await runCommand(command, { cwd, timeoutMs, signal: ctx.signal, onOutput: ctx.onOutput, windowsShell: ctx.config.shell.windows });
    return { ok: r.code === 0, output: formatResult(r, ctx.config.agent.maxToolOutputChars) };
  },
};

export const runTests: Tool = {
  name: 'run_tests',
  category: 'tests',
  description:
    'Run the project test suite (auto-detected: npm/pnpm/yarn test, pytest, cargo test, go test, dotnet test, make test) or a specific test command. Use after every change to verify it.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Optional explicit test command, e.g. "npx vitest run src/combat" or "python -m pytest tests/test_combat.py"' },
    },
  },
  risk: (a) => (a?.command && classifyCommand(String(a.command)).risky ? 'shell' : 'tests'),
  isRisky: (a) => !!a?.command && classifyCommand(String(a.command)).risky,
  isDangerous: (a) => !!a?.command && classifyCommand(String(a.command)).dangerous,
  summarize: (a) => `tests${a.command ? `: ${a.command}` : ''}`,
  approvalDetail: (a) => `$ ${a.command ?? '(auto-detected test command)'}`,
  async execute(a, ctx) {
    const command = a.command ? String(a.command) : (await ctx.getIndex()).testCommand;
    if (!command) {
      return {
        ok: false,
        output:
          'No test command detected for this project. Options: pass an explicit command, run a build/compile check with run_command, or (for game engines without CLI tests) verify by reading the code carefully and explaining what the user should test manually.',
      };
    }
    const r = await runCommand(command, {
      cwd: ctx.workspace.root,
      timeoutMs: ctx.config.shell.timeoutMs,
      signal: ctx.signal,
      onOutput: ctx.onOutput,
      windowsShell: ctx.config.shell.windows,
    });
    const verdict = r.code === 0 ? 'TESTS PASSED' : 'TESTS FAILED — read the errors above, fix the root cause, then run the tests again.';
    return { ok: r.code === 0, output: `$ ${command}\n${formatResult(r, ctx.config.agent.maxToolOutputChars)}\n\n${verdict}` };
  },
};

export const terminalTools = [runCommandTool, runTests];
