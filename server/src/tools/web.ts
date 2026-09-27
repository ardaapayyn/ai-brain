import { num, str, ToolArgError, truncate, type Tool } from './types.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 ai-brain/0.1';

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|section|article|header|footer)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function checkUrl(raw: string, selfPort: number): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolArgError('Invalid URL');
  }
  if (!/^https?:$/.test(url.protocol)) throw new ToolArgError('Only http(s) URLs are allowed');
  const local = /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/.test(url.hostname);
  if (local && Number(url.port || 80) === selfPort) throw new ToolArgError('The agent may not call the AI Brain server itself');
  return url;
}

export const fetchUrl: Tool = {
  name: 'fetch_url',
  category: 'web',
  description: 'Fetch a web page or API URL (docs, error explanations, local dev server) and return it as readable text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL' },
      max_chars: { type: 'integer', description: 'Max characters to return (default 8000)' },
    },
    required: ['url'],
  },
  risk: 'network',
  summarize: (a) => `fetch ${a.url}`,
  async execute(a, ctx) {
    const url = checkUrl(str(a, 'url'), ctx.config.port);
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]), redirect: 'follow' });
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = type.includes('html') ? htmlToText(body) : body;
    return { ok: res.ok, output: `HTTP ${res.status} ${type}\n\n${truncate(text, Math.min(num(a, 'max_chars', 8000), 30000))}` };
  },
};

export const webSearch: Tool = {
  name: 'web_search',
  category: 'web',
  description: 'Search the web (DuckDuckGo, no API key). Returns titles, URLs and snippets; follow up with fetch_url.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
  risk: 'network',
  summarize: (a) => `web "${a.query}"`,
  async execute(a, ctx) {
    const q = str(a, 'query');
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q }).toString(),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
    });
    const html = await res.text();
    const results: string[] = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    for (const m of html.matchAll(re)) {
      let href = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) href = decodeURIComponent(uddg[1]);
      results.push(`• ${htmlToText(m[2])}\n  ${href}\n  ${htmlToText(m[3] ?? '')}`);
      if (results.length >= 8) break;
    }
    return { ok: results.length > 0, output: results.length ? results.join('\n') : `No results (HTTP ${res.status}).` };
  },
};

export const webTools = [webSearch, fetchUrl];
