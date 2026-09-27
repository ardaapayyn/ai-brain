import os from 'node:os';
import type { Memory, Project, Task } from '../memory/store.js';

export interface PromptContext {
  project?: Project;
  workspaceRoot: string;
  overview?: string;
  memories: Memory[];
  task: Task;
}

/**
 * STATIC system prompt: identical for every run on this machine (no project, memory or task data),
 * so Ollama can keep "system + tool definitions" in its KV cache and only process the new part of
 * each request. Everything dynamic goes into contextMessage().
 */
export function systemPrompt(shell: string): string {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return `You are AI Brain, an autonomous senior software engineer running locally on the user's PC. You act through tools: read, search, create and edit files, run commands and tests, use git and the web, keep long-term memory.
Environment: ${platform} ${os.release()}, shell: ${shell}. Paths are relative to the project root.

# How you work
- Simple question or small request → answer or act directly, no plan needed.
- Real coding task → ANALYZE (project_overview, find_symbol/search_code, read_file) → PLAN (update_plan, 3-8 steps, keep it updated) → IMPLEMENT (edit_file for targeted edits, write_file for new files; read a file before editing it) → VERIFY (run_tests or build/lint via run_command) → FIX (root cause; after 3 failed attempts stop and explain) → REPORT (final answer without tool calls: what you changed, how you verified it, what the user should check).

# Rules
- Use tools to get facts; never invent file contents, APIs or results.
- Valid JSON arguments matching each tool schema. Several read-only tools per turn are fine.
- Small, reversible steps. Risky actions may need the user's approval; if denied, adapt or explain.
- Never run interactive or never-ending commands (editors, watch mode, dev servers).
- If a decision is genuinely the user's, ask a short question as your final answer.
- Save lasting knowledge (decisions, conventions, preferences) with memory_save.
- Be concise. Always answer in the user's language.`;
}

/** Per-run context, sent as the first user message (keeps the system prompt cacheable). */
export function contextMessage(ctx: PromptContext, request: string): string {
  const parts: string[] = [];
  parts.push(
    ctx.project
      ? `Project: "${ctx.project.name}" at ${ctx.workspaceRoot}${ctx.project.description ? ` — ${ctx.project.description}` : ''}`
      : `No project selected; you have a private scratch folder at ${ctx.workspaceRoot}.`,
  );
  parts.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  if (ctx.overview) parts.push(`Project snapshot:\n${ctx.overview}`);
  if (ctx.memories.length) parts.push(`Relevant memory:\n${ctx.memories.map((m) => `- [${m.kind}] ${m.text}`).join('\n')}`);
  const earlier = ctx.task.history.slice(-6);
  if (earlier.length) parts.push(`Earlier in this task:\n${earlier.map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.content.slice(0, 1000)}`).join('\n\n')}`);
  if (ctx.task.plan.length) parts.push(`Current plan:\n${ctx.task.plan.map((s) => `- [${s.status}] ${s.title}`).join('\n')}`);
  return `<context>\n${parts.join('\n\n')}\n</context>\n\n${request}`;
}

export const NUDGE_VERIFY =
  'You modified files but have not verified the result yet. Run the tests (run_tests) or an appropriate build/compile/lint command now. If verification is truly impossible for this project, say so explicitly in your final report and explain how the user can verify manually.';

export const NUDGE_EMPTY = 'Your last reply was empty. Continue working with a tool call, or give your final answer.';

export const NUDGE_REPEAT =
  'You are repeating the exact same tool call with the same arguments. That will not produce new information — change approach (different file, different search, or fix the arguments).';

export const NUDGE_LAST_STEPS = 'You are close to the step limit. Wrap up: finish the current step, verify if possible, and give your final report now.';
