import type { ChatMessage } from '../llm/types.js';
import { estimateTokens } from '../llm/util.js';

const msgTokens = (m: ChatMessage) => estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 4;

export const totalTokens = (msgs: ChatMessage[]) => msgs.reduce((s, m) => s + msgTokens(m), 0);

/**
 * Keep the conversation inside the model's context window. Local models have small windows,
 * so we degrade gracefully:
 *  1. elide old tool outputs (keep a short head so the model remembers what it saw),
 *  2. drop whole old assistant+tool groups (keeps tool-call/result pairing valid),
 * always preserving the system prompt, the user's request and the most recent turns.
 */
export function compactMessages(msgs: ChatMessage[], budgetTokens: number, keepRecent = 8): ChatMessage[] {
  if (totalTokens(msgs) <= budgetTokens) return msgs;
  const out = msgs.map((m) => ({ ...m }));
  const firstUser = out.findIndex((m) => m.role === 'user');
  const protectedFrom = Math.max(firstUser + 1, out.length - keepRecent);

  for (let i = firstUser + 1; i < protectedFrom && totalTokens(out) > budgetTokens; i++) {
    const m = out[i];
    if (m.role === 'tool' && m.content.length > 400) {
      m.content = `${m.content.slice(0, 300)}\n… [older output elided to save context — re-run the tool if you need it again]`;
    } else if (m.role === 'assistant' && m.content.length > 1200) {
      m.content = m.content.slice(0, 1000) + ' …';
    }
  }
  if (totalTokens(out) <= budgetTokens) return out;

  // Drop oldest groups (assistant + its tool results) after the first user message.
  let i = firstUser + 1;
  let dropped = 0;
  while (totalTokens(out) > budgetTokens && i < out.length - keepRecent) {
    if (out[i].role === 'assistant') {
      let j = i + 1;
      while (j < out.length && out[j].role === 'tool') j++;
      if (j >= out.length - keepRecent) break;
      out.splice(i, j - i);
      dropped++;
    } else i++;
  }
  if (dropped) {
    out.splice(firstUser + 1, 0, {
      role: 'user',
      content: `[Note: ${dropped} earlier step(s) were removed to fit the context window. Rely on the current plan and re-read files if needed.]`,
    });
  }
  return out;
}
