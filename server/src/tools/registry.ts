import type { BrainConfig } from '../config.js';
import { brainTools } from './brain.js';
import { filesystemTools } from './filesystem.js';
import { gitTools } from './git.js';
import { searchTools } from './search.js';
import { terminalTools } from './terminal.js';
import { toSpec, type RiskClass, type Tool } from './types.js';
import { webTools } from './web.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = defaultTools()) {
    for (const t of tools) this.register(t);
  }

  register(t: Tool) {
    if (this.tools.has(t.name)) throw new Error(`Duplicate tool ${t.name}`);
    this.tools.set(t.name, t);
  }

  get(name: string) {
    return this.tools.get(name);
  }
  list() {
    return [...this.tools.values()];
  }
  specs() {
    return this.list().map(toSpec);
  }
}

export function defaultTools(): Tool[] {
  return [...searchTools, ...filesystemTools, ...terminalTools, ...gitTools, ...webTools, ...brainTools];
}

export function riskOf(tool: Tool, args: any): RiskClass {
  return typeof tool.risk === 'function' ? tool.risk(args) : tool.risk;
}

/** Decide whether a call needs a human "yes" given the configured policies. */
export function needsApproval(tool: Tool, args: any, approvals: BrainConfig['approvals']): boolean {
  const risk = riskOf(tool, args);
  if (risk === 'none') return false;
  if (tool.isDangerous?.(args)) return true; // destructive actions always ask, whatever the policy
  const policy = approvals[risk];
  if (policy === 'auto') return false;
  if (policy === 'ask') return true;
  return tool.isRisky ? tool.isRisky(args) : true; // ask-risky
}
