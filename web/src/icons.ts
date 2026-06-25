// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Inline SVG icon set (static, trusted markup — never user data). Stroke-based,
 * currentColor, 24x24 viewBox, so they inherit the nav/component color + size.
 */

const P =
  'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const PATHS: Record<string, string> = {
  overview: `<rect x="3" y="3" width="7" height="9" rx="1.5" ${P}/><rect x="14" y="3" width="7" height="5" rx="1.5" ${P}/><rect x="14" y="12" width="7" height="9" rx="1.5" ${P}/><rect x="3" y="16" width="7" height="5" rx="1.5" ${P}/>`,
  fleet: `<circle cx="9" cy="8" r="3" ${P}/><path d="M3 20a6 6 0 0 1 12 0" ${P}/><path d="M16 5.5a3 3 0 0 1 0 5M21 20a5.5 5.5 0 0 0-4-5.3" ${P}/>`,
  kanban: `<rect x="3" y="4" width="5" height="16" rx="1.5" ${P}/><rect x="10" y="4" width="5" height="10" rx="1.5" ${P}/><rect x="17" y="4" width="4" height="13" rx="1.5" ${P}/>`,
  ideas: `<path d="M9 18h6M10 21h4" ${P}/><path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3Z" ${P}/>`,
  memories: `<ellipse cx="12" cy="5.5" rx="7" ry="2.6" ${P}/><path d="M5 5.5v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6M5 11.5v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" ${P}/>`,
  schedules: `<circle cx="12" cy="12" r="8.5" ${P}/><path d="M12 7v5l3.5 2" ${P}/>`,
  skills: `<path d="M12 3l2.2 4.6 5 .7-3.6 3.5.9 5L12 14.9 7.5 16.8l.9-5L4.8 8.3l5-.7L12 3Z" ${P}/>`,
  vault: `<rect x="4" y="10" width="16" height="10" rx="2" ${P}/><path d="M8 10V7a4 4 0 0 1 8 0v3" ${P}/><circle cx="12" cy="15" r="1.6" ${P}/>`,
  channels: `<path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12Z" ${P}/>`,
  approvals: `<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" ${P}/><path d="M9 12l2 2 4-4" ${P}/>`,
  settings: `<path d="M5 6h14M5 12h14M5 18h14" ${P}/><circle cx="9" cy="6" r="2" fill="var(--bg-card)" ${P}/><circle cx="15" cy="12" r="2" fill="var(--bg-card)" ${P}/><circle cx="8" cy="18" r="2" fill="var(--bg-card)" ${P}/>`,
  gear: `<circle cx="12" cy="12" r="3.2" ${P}/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" ${P}/>`,
  sun: `<circle cx="12" cy="12" r="4" ${P}/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" ${P}/>`,
  moon: `<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z" ${P}/>`,
  // delegation / inter-agent message: a right-pointing arrow
  arrow: `<path d="M4 12h15M13 6l6 6-6 6" ${P}/>`,
  // agents roster: a small group of people
  people: `<circle cx="8" cy="9" r="3" ${P}/><path d="M2.5 19a5.5 5.5 0 0 1 11 0" ${P}/><path d="M15.5 6.3a3 3 0 0 1 0 5.4M17 19a5.5 5.5 0 0 0-3.2-5" ${P}/>`,
  // live session terminal
  terminal: `<rect x="3" y="4" width="18" height="16" rx="2" ${P}/><path d="M7 9l3 3-3 3M13 15h4" ${P}/>`,
  // edit / change
  pencil: `<path d="M4 20h4L19 9l-4-4L4 16v4Z" ${P}/><path d="M14 6l4 4" ${P}/>`,
  // delete
  trash: `<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" ${P}/>`,
  // add / new
  plus: `<path d="M12 5v14M5 12h14" ${P}/>`,
  // team / org-chart: a parent node branching to two children
  team: `<rect x="9" y="3" width="6" height="5" rx="1.2" ${P}/><rect x="3" y="16" width="6" height="5" rx="1.2" ${P}/><rect x="15" y="16" width="6" height="5" rx="1.2" ${P}/><path d="M12 8v3.5M6 16v-2.5h12V16" ${P}/>`,
  // reload / refresh: a circular arrow
  refresh: `<path d="M21 12a9 9 0 1 1-2.64-6.36" ${P}/><path d="M21 4v5h-5" ${P}/>`,
  // messages: a speech bubble with a bottom-left tail
  messages: `<path d="M20 4H4a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 16h3v3.5L11.5 16H20a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 20 4Z" ${P}/>`,
  // schedules view-mode toggles
  list: `<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" ${P}/>`,
  timelineAxis: `<path d="M3 12h18M6 9v6M12 9v6M18 9v6" ${P}/>`,
  weekgrid: `<rect x="3" y="4" width="18" height="16" rx="2" ${P}/><path d="M3 9h18M9 9v11M15 9v11" ${P}/>`,
  pause: `<rect x="7" y="5" width="3.2" height="14" rx="1" ${P}/><rect x="13.8" y="5" width="3.2" height="14" rx="1" ${P}/>`,
  play: `<path d="M7 5l12 7-12 7V5Z" ${P}/>`,
  // journal / recall: an open book
  journal: `<path d="M12 6c-2-1.4-5-1.4-7.5 0V19c2.5-1.4 5.5-1.4 7.5 0M12 6c2-1.4 5-1.4 7.5 0V19c-2.5-1.4-5.5-1.4-7.5 0M12 6v13" ${P}/>`,
  // recall / log: a clock with a history (counter-clockwise) arrow
  history: `<path d="M3.5 9a9 9 0 1 1-1 4" ${P}/><path d="M3 4v5h5" ${P}/><path d="M12 8v4.5l3 1.8" ${P}/>`,
  // memory event: a stylized brain glyph
  brain: `<path d="M9.5 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1.5 4.4A2.5 2.5 0 0 0 6 16a2.5 2.5 0 0 0 3.5 2.3V4.5Z" ${P}/><path d="M14.5 4.5A2.5 2.5 0 0 1 17 7a2.5 2.5 0 0 1 1.5 4.4A2.5 2.5 0 0 1 18 16a2.5 2.5 0 0 1-3.5 2.3V4.5Z" ${P}/>`,
  // background tasks: a monitor screen running a process, on a small stand
  screen: `<rect x="3" y="4" width="18" height="12" rx="1.6" ${P}/><path d="M7 8l2.5 2L7 12M12.5 12h4M9 20h6M12 16v4" ${P}/>`,
  // mcp / connectors: two interlocking plug links
  plug: `<path d="M9 15l-3 3a2.8 2.8 0 0 1-4-4l3-3" ${P}/><path d="M15 9l3-3a2.8 2.8 0 0 1 4 4l-3 3" ${P}/><path d="M9 9l6 6" ${P}/>`,
  // status: an EKG / heartbeat pulse line
  pulse: `<path d="M3 12h4l2-6 4 12 2-6h6" ${P}/>`,
  // search: a magnifier (used by the Memory + Journal search fields)
  search: `<circle cx="11" cy="11" r="7" ${P}/><path d="M21 21l-4.3-4.3" ${P}/>`,
  // token monitor: a small bar-chart / gauge
  gauge: `<path d="M6 20v-5M12 20v-9M18 20v-3" ${P}/><path d="M3 20h18" ${P}/><path d="M5 9a7 7 0 0 1 14 0" ${P} stroke-dasharray="2 2"/>`,
  // autonomy: a shield (trust boundary)
  shield: `<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" ${P}/>`,
  // hard-lock marker: a padlock
  lock: `<rect x="5" y="11" width="14" height="9" rx="1.6" ${P}/><path d="M8 11V8a4 4 0 0 1 8 0v3" ${P}/>`,
  // reveal: an open eye
  eye: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" ${P}/><circle cx="12" cy="12" r="3" ${P}/>`,
  // hide: a crossed-out eye
  eyeOff: `<path d="M3 3l18 18" ${P}/><path d="M10.6 10.6a3 3 0 0 0 4 4M9.4 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.3 6.3A17 17 0 0 0 2 12s3.5 7 10 7a9.5 9.5 0 0 0 3-.5" ${P}/>`,
  // migration: an arrow rising out of an open tray (import into the house)
  import: `<path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" ${P}/><path d="M12 3v11M8 7l4-4 4 4" ${P}/>`,
  // updates: two arrows chasing each other in a loop
  sync: `<path d="M21 8a8 8 0 0 0-14.3-3.2M3 4v4h4" ${P}/><path d="M3 16a8 8 0 0 0 14.3 3.2M21 20v-4h-4" ${P}/>`,
  // studio: a camera aperture / shutter
  aperture: `<circle cx="12" cy="12" r="9" ${P}/><path d="M12 3v6M21 9l-5.2 3M19 18l-5.2-3M5 18l5.2-3M3 9l5.2 3M12 21v-6" ${P}/>`,
  // activity: a live-signal / broadcast emanation (radar rings + center dot)
  signal: `<circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none"/><path d="M8 14a5.5 5.5 0 0 1 8 0M5 11a9.5 9.5 0 0 1 14 0" ${P}/>`,
  // files: a folder with a stacked sheet peeking out
  folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" ${P}/><path d="M8 11h8" ${P}/>`,
};

/** Build an inline SVG icon element. `name` must be a known static key. */
export function icon(name: keyof typeof PATHS | string, size = 18): HTMLElement {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.setAttribute('aria-hidden', 'true');
  const body = PATHS[name] ?? '';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" role="img">${body}</svg>`;
  return span;
}
