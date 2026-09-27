type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript helper: h('div', {class: 'x', onclick}, children…) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s fa`;
  if (s < 3600) return `${Math.round(s / 60)}m fa`;
  if (s < 86400) return `${Math.round(s / 3600)}h fa`;
  return new Date(ts).toLocaleDateString();
}

export function duration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** Minimal, safe markdown: fenced code, inline code, bold/italic, headings, lists, links. */
export function markdown(src: string): string {
  const blocks: string[] = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre class="code"><code data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  text = esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = text.split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    const ul = /^\s*[-*•]\s+(.*)/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
    const hd = /^(#{1,4})\s+(.*)/.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${(ul ?? ol)![1]}</li>`);
    } else {
      close();
      if (hd) out.push(`<h${hd[1].length + 2}>${hd[2]}</h${hd[1].length + 2}>`);
      else if (/^\u0000\d+\u0000$/.test(line.trim())) out.push(line.trim());
      else if (line.trim()) out.push(`<p>${line}</p>`);
    }
  }
  close();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}
