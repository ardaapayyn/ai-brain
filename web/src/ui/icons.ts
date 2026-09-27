/** Hand-tuned stroke icon set (24×24, lucide-style). */
const P: Record<string, string> = {
  filesystem: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m7 9.5 3 2.5-3 2.5"/><path d="M12.5 15H17"/>',
  git: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8v8"/><path d="M18 10.5c0 4.5-7 3.5-11.2 6.3"/>',
  tests: '<path d="M9 3h6"/><path d="M10 3v6.2L4.6 18.4A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.6-2.6L14 9.2V3"/><path d="M7.2 15h9.6"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
  memory: '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13"/><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>',
  planning: '<path d="m3.5 6.5 1.8 1.8L8.8 5"/><path d="m3.5 16.5 1.8 1.8L8.8 15"/><path d="M12.5 7h8"/><path d="M12.5 12h8"/><path d="M12.5 17h8"/>',
  sparkles: '<path d="M11 3.5 12.9 9l5.6 2-5.6 2L11 18.5 9.1 13l-5.6-2 5.6-2z"/><path d="M18.5 3v4M16.5 5h4"/><path d="M19 16.5v3M17.5 18h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/>',
  settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m5.5 11.5 6.5-6.5 6.5 6.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  followUp: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  shield: '<path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  file: '<path d="M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M14 3v6h6"/>',
  download: '<path d="M12 3.5v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20.5h14"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6L20.5 8.5"/><path d="M20.5 3.5v5h-5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  module: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  task: '<path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
  project: '<path d="M12 2.5 20.5 7.3v9.4L12 21.5l-8.5-4.8V7.3z"/><path d="M12 12 20.5 7.3M12 12v9.5M12 12 3.5 7.3"/>',
  core: '<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="10" ry="4.2"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0 5 5l-8.9 8.9a2.1 2.1 0 0 1-3-3z"/><path d="M14.7 6.3 17 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  gauge: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="m12 13 4-4.5"/>',
  eye: '<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.1 3.9M6.6 6.6A17 17 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 4.4-1"/>',
  folderOpen: '<path d="M3 17.5v-10A2.5 2.5 0 0 1 5.5 5H9l2 2h6.5A2.5 2.5 0 0 1 20 9.5V10"/><path d="M3 17.5 5.7 11.8A2 2 0 0 1 7.5 10.6h13a1 1 0 0 1 .9 1.4l-2.6 6.3a2.5 2.5 0 0 1-2.3 1.7H5.5A2.5 2.5 0 0 1 3 17.5z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
  bolt: '<path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
  folderPlus: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.5v6M9 13.5h6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  drive: '<rect x="2.5" y="13" width="19" height="7" rx="2"/><path d="M5.5 13 8 5h8l2.5 8"/><path d="M17 16.5h.01"/>',
  home: '<path d="m3 11 9-7.5 9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5.5h4V20"/>',
  radar: '<path d="M19.1 4.9A10 10 0 1 0 21.5 12"/><path d="M16.2 7.8A6 6 0 1 0 18 12"/><path d="M12 12 19 5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>',
  logo: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7" opacity=".55"/><circle cx="12" cy="12" r="10.5" opacity=".25"/><circle cx="19" cy="7.5" r="1.3" fill="currentColor"/><circle cx="5.5" cy="15.5" r="1" fill="currentColor"/>',
};

export type IconName = keyof typeof P;

export function icon(name: string, size = 16, cls = ''): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P.sparkles}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

export const CATEGORY_ICON: Record<string, string> = {
  filesystem: 'filesystem',
  search: 'search',
  terminal: 'terminal',
  git: 'git',
  tests: 'tests',
  web: 'web',
  memory: 'memory',
  planning: 'planning',
};

export const TYPE_ICON: Record<string, string> = { core: 'core', tool: 'tool', project: 'project', module: 'module', task: 'task', memory: 'memory' };
