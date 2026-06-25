// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Token Monitor view (PROMPT-14 §2b): usage accounting against the rolling
 * rate-limit windows — NEVER money. Per-agent summary cards, two budget cards
 * (5h + weekly rolling windows), a custom canvas timeline (stacked per-agent
 * bars + two resetting cumulative overlay lines + reset guides + peak shading +
 * hover tooltip + clickable legend), and a sortable/searchable details table.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Summary { agent: string; totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheCreation: number; totalCalls: number }
interface Point { bucket: number; agent: string; calls: number; inputTokens: number; outputTokens: number }
interface CallRow { timestamp: string; agent: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; content_preview: string | null; tool_name: string | null; task_title: string | null }
interface RosterAgent { id: string; displayName: string; accentColor: string }

type Period = '1h' | '24h' | '7d' | '30d';
type SortCol = 'time' | 'agent' | 'input' | 'output';

const HOUR = 3600_000;
const PERIODS: Period[] = ['1h', '24h', '7d', '30d'];
const PALETTE = ['#7c5cff', '#ff6b35', '#33c2a6', '#e8b84b', '#4b9fe8', '#e85ba0'];

let period: Period = '7d';
let agentFilter = '';
let budgetFocus: '5h' | 'weekly' | null = null;
// cumulative-window line visibility, toggled by clicking their legend entries (§4f)
let show5h = true;
let showWk = true;
let minTokens = 50000;
let searchQuery = '';
let sortCol: SortCol = 'time';
let sortDir: 'asc' | 'desc' = 'desc';

// The chart re-draws on resize from the last fetched data; bind the listener
// once at module load so repeated renders never stack listeners.
let currentDraw: () => void = () => {};
let resizeBound = false;

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
function periodRange(p: Period): { fromMs: number; bucketMin: number } {
  const now = Date.now();
  if (p === '1h') return { fromMs: now - HOUR, bucketMin: 5 };
  if (p === '24h') return { fromMs: now - 24 * HOUR, bucketMin: 60 };
  if (p === '30d') return { fromMs: now - 30 * 24 * HOUR, bucketMin: 60 };
  return { fromMs: now - 7 * 24 * HOUR, bucketMin: 60 };
}
function mondayMidnight(ms: number): number {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  return d.getTime() - day * 24 * HOUR;
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  void store;
  const { fromMs, bucketMin } = periodRange(period);
  const from = new Date(fromMs).toISOString();
  const to = new Date().toISOString();
  const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const agentQ = agentFilter !== '' ? `&agent=${encodeURIComponent(agentFilter)}` : '';

  let summary: Summary[] = [];
  let points: Point[] = [];
  let roster: RosterAgent[] = [];
  try {
    [summary, points, roster] = await Promise.all([
      api.get<Summary[]>(`/api/token-usage/summary?${range}`),
      api.get<Point[]>(`/api/token-usage/timeline?${range}&bucket=${bucketMin}${agentQ}`),
      api.get<RosterAgent[]>('/api/agents').catch(() => [] as RosterAgent[]),
    ]);
  } catch { /* leave empties */ }

  const colorOf = (() => {
    const map = new Map<string, string>();
    roster.forEach((a) => map.set(a.id, a.accentColor || ''));
    const ids = [...new Set(summary.map((s) => s.agent))];
    ids.forEach((id, i) => { if (!map.get(id)) map.set(id, PALETTE[i % PALETTE.length]!); });
    return (id: string): string => map.get(id) || '#8a8f98';
  })();
  const nameOf = (id: string): string => roster.find((a) => a.id === id)?.displayName ?? id;

  const reload = (): void => void render(host, store);

  // ---------- details ----------
  const detailsBody = h('tbody', null);
  const countLabel = h('span', { class: 'details-count' }, '');
  let rows: CallRow[] = [];
  const loadDetails = async (): Promise<void> => {
    const q = searchQuery.trim() !== '' ? `&q=${encodeURIComponent(searchQuery.trim())}` : `&min_tokens=${minTokens}`;
    try { rows = await api.get<CallRow[]>(`/api/token-usage?${range}${agentQ}${q}&limit=200`); } catch { rows = []; }
    renderDetails();
  };
  const sortRows = (rs: CallRow[]): CallRow[] => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const inSide = (r: CallRow): number => r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    return [...rs].sort((a, b) => {
      if (sortCol === 'agent') return a.agent.localeCompare(b.agent) * dir;
      if (sortCol === 'input') return (inSide(a) - inSide(b)) * dir;
      if (sortCol === 'output') return (a.output_tokens - b.output_tokens) * dir;
      return (Date.parse(a.timestamp) - Date.parse(b.timestamp)) * dir;
    });
  };
  const renderDetails = (): void => {
    const sorted = sortRows(rows);
    countLabel.textContent = t('tokenmon.details.count', { N: sorted.length });
    if (sorted.length === 0) { mount(detailsBody, h('tr', null, h('td', { colspan: 5, class: 'muted-note center' }, t('tokenmon.details.empty')))); return; }
    mount(detailsBody, ...sorted.map((r) => {
      const inSide = r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens;
      const d = new Date(r.timestamp);
      const time = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const content = h('td', { class: 'col-content', title: r.content_preview ?? '' });
      if (r.tool_name) content.append(h('code', null, r.tool_name), ' ');
      content.append(document.createTextNode((r.content_preview ?? '').slice(0, 80)));
      return h('tr', null,
        h('td', { class: 'nowrap' }, time),
        h('td', null, h('strong', { style: `color:${colorOf(r.agent)}` }, nameOf(r.agent)), ...(r.task_title ? [h('span', { class: 'task-suffix muted-note' }, ` [${r.task_title}]`)] : [])),
        h('td', { class: 'num' }, fmtTokens(inSide)),
        h('td', { class: 'num' }, fmtTokens(r.output_tokens)),
        content,
      );
    }));
  };

  // ---------- canvas chart ----------
  const canvas = h('canvas', { class: 'tm-canvas' }) as HTMLCanvasElement;
  const tooltip = h('div', { class: 'tm-tooltip', style: 'display:none' });
  // build bucket model
  const agents = [...new Set(points.map((p) => p.agent))];
  const bucketTimes = [...new Set(points.map((p) => p.bucket))].sort((a, b) => a - b);
  const byBucket = new Map<number, Map<string, number>>();
  for (const b of bucketTimes) byBucket.set(b, new Map());
  for (const p of points) byBucket.get(p.bucket)!.set(p.agent, (byBucket.get(p.bucket)!.get(p.agent) ?? 0) + p.inputTokens);
  const bucketTotal = (b: number): number => [...byBucket.get(b)!.values()].reduce((s, v) => s + v, 0);
  // cumulative windows
  const cum5h: number[] = []; const cumWk: number[] = [];
  let acc5 = 0, accW = 0, win5 = -1, winW = -1;
  for (const b of bucketTimes) {
    const ms = b * 1000;
    const w5 = Math.floor(ms / (5 * HOUR));
    const ww = mondayMidnight(ms);
    if (w5 !== win5) { acc5 = 0; win5 = w5; }
    if (ww !== winW) { accW = 0; winW = ww; }
    acc5 += bucketTotal(b); accW += bucketTotal(b);
    cum5h.push(acc5); cumWk.push(accW);
  }
  const budget5 = cum5h.length ? cum5h[cum5h.length - 1]! : 0;
  const budgetWk = cumWk.length ? cumWk[cumWk.length - 1]! : 0;

  const drawChart = (): void => {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(320, rect.width), H = canvas.height = (window.innerWidth <= 768 ? 220 : 360);
    canvas.width = W;
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--text-muted').trim() || '#888';
    const grid = css.getPropertyValue('--border').trim() || '#333';
    if (bucketTimes.length === 0) { ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.font = '14px sans-serif'; ctx.fillText(t('tokenmon.timeline.empty'), W / 2, H / 2); return; }
    const padL = 54, padR = 54, padT = 14, padB = 56;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxBar = Math.max(1, ...bucketTimes.map(bucketTotal));
    const maxCum = Math.max(1, ...cum5h, ...cumWk);
    const n = bucketTimes.length;
    const bw = Math.max(2, (plotW / n) * 0.7);
    const xAt = (i: number): number => padL + (plotW / n) * (i + 0.5);
    const yBar = (v: number): number => padT + plotH - (v / maxBar) * plotH;
    const yCum = (v: number): number => padT + plotH - (v / maxCum) * plotH;
    // peak shading (weekday 09:00-12:00 local)
    ctx.fillStyle = 'rgba(232,184,75,0.07)';
    bucketTimes.forEach((b, i) => { const d = new Date(b * 1000); const wd = d.getDay(); if (wd >= 1 && wd <= 5 && d.getHours() >= 9 && d.getHours() < 12) ctx.fillRect(padL + (plotW / n) * i, padT, plotW / n, plotH); });
    // reset guides
    const guide = (i: number, color: string, dash: number[]): void => { ctx.save(); ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.beginPath(); const x = padL + (plotW / n) * i; ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke(); ctx.restore(); };
    bucketTimes.forEach((b, i) => { const ms = b * 1000; const d = new Date(ms); if (d.getDay() === 1 && d.getHours() === 0) guide(i, 'rgba(123,92,255,0.5)', [2, 3]); else if (d.getHours() === 0) guide(i, 'rgba(120,120,120,0.4)', [1, 4]); else if (ms % (5 * HOUR) < bucketMin * 60_000) guide(i, 'rgba(51,194,166,0.3)', [1, 5]); });
    // axes
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
    ctx.fillStyle = ink; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    for (let k = 0; k <= 4; k += 1) { const v = (maxBar / 4) * k; const y = yBar(v); ctx.fillText(fmtTokens(v), padL - 6, y + 3); }
    ctx.textAlign = 'left';
    for (let k = 0; k <= 4; k += 1) { const v = (maxCum / 4) * k; const y = yCum(v); ctx.fillStyle = 'rgba(51,194,166,0.8)'; ctx.fillText(fmtTokens(v), padL + plotW + 6, y + 3); }
    // bars (stacked per agent, dimmed if a budget focus is active)
    const barAlpha = budgetFocus ? 0.25 : 1;
    bucketTimes.forEach((b, i) => {
      let yTop = yBar(0);
      const segs = byBucket.get(b)!;
      for (const ag of (agentFilter !== '' ? [agentFilter] : agents)) {
        const v = segs.get(ag) ?? 0; if (v <= 0) continue;
        const hgt = (v / maxBar) * plotH;
        ctx.globalAlpha = barAlpha; ctx.fillStyle = colorOf(ag);
        ctx.fillRect(xAt(i) - bw / 2, yTop - hgt, bw, hgt);
        yTop -= hgt;
      }
      ctx.globalAlpha = 1;
    });
    // cumulative lines
    const line = (vals: number[], color: string, emph: boolean): void => {
      ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = budgetFocus && !emph ? 0.2 : 1; ctx.lineWidth = emph ? 2.4 : 1.4; ctx.beginPath();
      vals.forEach((v, i) => { const x = xAt(i), y = yCum(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.restore();
    };
    if (show5h) line(cum5h, '#33c2a6', budgetFocus === '5h');
    if (showWk) line(cumWk, '#e8b84b', budgetFocus === 'weekly');
    // x labels (~8)
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.font = '10px sans-serif';
    const step = Math.max(1, Math.floor(n / 8));
    bucketTimes.forEach((b, i) => { if (i % step !== 0) return; const d = new Date(b * 1000); const lbl = period === '1h' || period === '24h' ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`; ctx.fillText(lbl, xAt(i), padT + plotH + 16); });
    // legend — per-agent swatches, the two cumulative windows (click to toggle,
    // §4f), plus the reset-guide and peak-shading keys.
    let lx = padL, ly = H - 14; ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
    const legendHits: Array<{ x0: number; x1: number; toggle: 'show5h' | 'showWk' }> = [];
    const legend = (color: string, label: string, opts: { dash?: boolean; fade?: boolean; toggle?: 'show5h' | 'showWk' } = {}): void => {
      const x0 = lx;
      ctx.save();
      ctx.globalAlpha = opts.fade ? 0.4 : 1;
      if (opts.dash) { ctx.strokeStyle = color; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(lx, ly - 3); ctx.lineTo(lx + 12, ly - 3); ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fillStyle = color; ctx.fillRect(lx, ly - 8, 9, 9); }
      lx += 14; ctx.fillStyle = ink; ctx.fillText(label, lx, ly);
      const w = ctx.measureText(label).width;
      if (opts.fade) { ctx.strokeStyle = ink; ctx.beginPath(); ctx.moveTo(lx, ly - 3); ctx.lineTo(lx + w, ly - 3); ctx.stroke(); } // strike a hidden line
      ctx.restore();
      lx += w + 14;
      if (opts.toggle) legendHits.push({ x0, x1: lx, toggle: opts.toggle });
    };
    for (const ag of agents) legend(colorOf(ag), nameOf(ag));
    legend('#33c2a6', t('tokenmon.legend.5hWindow'), { toggle: 'show5h', fade: !show5h });
    legend('#e8b84b', t('tokenmon.legend.weeklyWindow'), { toggle: 'showWk', fade: !showWk });
    legend('rgba(123,92,255,0.8)', t('tokenmon.legend.resetGuide'), { dash: true });
    legend('rgba(232,184,75,0.4)', t('tokenmon.legend.peak'));
    // tooltip + legend hit models stored
    (canvas as unknown as { _model: unknown; _legend: unknown })._model = { padL, plotW, n, bucketTimes, xAt };
    (canvas as unknown as { _legend: unknown })._legend = { hits: legendHits, band: H - 24 };
  };

  canvas.addEventListener('mousemove', (e) => {
    const m = (canvas as unknown as { _model?: { padL: number; plotW: number; n: number; bucketTimes: number[] } })._model;
    if (!m || m.n === 0) { tooltip.style.display = 'none'; return; }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.floor(((x - m.padL) / m.plotW) * m.n);
    if (i < 0 || i >= m.n) { tooltip.style.display = 'none'; return; }
    const b = m.bucketTimes[i]!; const d = new Date(b * 1000);
    const segs = byBucket.get(b)!;
    const peak = d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 9 && d.getHours() < 12;
    const lines = [...segs.entries()].filter(([, v]) => v > 0).map(([ag, v]) => `<span style="color:${colorOf(ag)}">■</span> ${nameOf(ag)}: ${fmtTokens(v)}`);
    tooltip.innerHTML = `<b>${d.toLocaleString(currentLocale())}${peak ? ` · ${t('tokenmon.tooltip.peak')}` : ''}</b><br>${lines.join('<br>')}${lines.length > 1 ? `<br>${t('tokenmon.tooltip.total')}: ${fmtTokens(bucketTotal(b))}` : ''}<hr>5h: ${fmtTokens(cum5h[i] ?? 0)} · ${t('tokenmon.budget.weekly')}: ${fmtTokens(cumWk[i] ?? 0)}`;
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.min(x + 12, rect.width - 180)}px`;
    tooltip.style.top = '20px';
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  // §4f: clicking a cumulative-window legend entry toggles that line on/off
  canvas.addEventListener('click', (e) => {
    const lg = (canvas as unknown as { _legend?: { hits: Array<{ x0: number; x1: number; toggle: 'show5h' | 'showWk' }>; band: number } })._legend;
    if (!lg) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (y < lg.band) return; // only the bottom legend strip is clickable
    const hit = lg.hits.find((hb) => x >= hb.x0 && x <= hb.x1);
    if (!hit) return;
    if (hit.toggle === 'show5h') show5h = !show5h; else showWk = !showWk;
    currentDraw();
  });
  currentDraw = (): void => { if (canvas.isConnected) drawChart(); };
  if (!resizeBound) { resizeBound = true; window.addEventListener('resize', () => currentDraw()); }

  // ---------- summary cards ----------
  const sortedSummary = [...summary].sort((a, b) => (b.totalInput + b.totalCacheRead + b.totalCacheCreation) - (a.totalInput + a.totalCacheRead + a.totalCacheCreation));
  const summaryRow = h('div', { class: 'tm-summary' });
  if (sortedSummary.length === 0) {
    mount(summaryRow, h('div', { class: 'stat-card tm-card' }, h('div', { class: 'stat-label' }, t('tokenmon.summary.empty.label')), h('div', { class: 'stat-value' }, '0'), h('div', { class: 'stat-sub muted-note' }, t('tokenmon.summary.empty.sub'))));
  } else {
    mount(summaryRow, ...sortedSummary.map((s) => {
      const inSide = s.totalInput + s.totalCacheRead + s.totalCacheCreation;
      const active = agentFilter === s.agent;
      const card = h('div', { class: `stat-card tm-card${active ? ' active' : ''}${agentFilter !== '' && !active ? ' dim' : ''}`, style: `border-left:3px solid ${colorOf(s.agent)}`, role: 'button', onclick: () => { agentFilter = active ? '' : s.agent; reload(); } },
        h('div', { class: 'stat-label' }, nameOf(s.agent)),
        h('div', { class: 'stat-value' }, fmtTokens(inSide)),
        h('div', { class: 'stat-sub muted-note' }, t('tokenmon.summary.sub', { calls: s.totalCalls.toLocaleString(currentLocale()), output: fmtTokens(s.totalOutput) })),
      );
      return card;
    }));
  }

  // ---------- budget cards ----------
  const budgetCard = (kind: '5h' | 'weekly', value: number, color: string): HTMLElement =>
    h('div', { class: `stat-card budget-card${budgetFocus === kind ? ' active' : ''}${budgetFocus && budgetFocus !== kind ? ' dim' : ''}`, style: `border-left:3px solid ${color}`, role: 'button', onclick: () => { budgetFocus = budgetFocus === kind ? null : kind; drawChart(); reload(); } },
      h('div', { class: 'stat-label' }, t(kind === '5h' ? 'tokenmon.budget.5h' : 'tokenmon.budget.weekly')),
      h('div', { class: 'stat-value' }, fmtTokens(value)),
      h('div', { class: 'stat-sub muted-note' }, t('tokenmon.budget.sub')),
    );

  // ---------- controls ----------
  const periodSel = h('select', { class: 'tm-period', onchange: (e: Event) => { period = (e.target as HTMLSelectElement).value as Period; agentFilter = ''; budgetFocus = null; reload(); } },
    ...PERIODS.map((p) => h('option', { value: p, selected: p === period }, t(`tokenmon.period.${p}`)))) as HTMLSelectElement;
  const agentSel = h('select', { class: 'tm-agent', onchange: (e: Event) => { agentFilter = (e.target as HTMLSelectElement).value; reload(); } },
    h('option', { value: '' }, t('tokenmon.agent.all')),
    ...sortedSummary.map((s) => h('option', { value: s.agent, selected: s.agent === agentFilter }, nameOf(s.agent)))) as HTMLSelectElement;
  const collectBtn = h('button', { class: 'secondary' }, icon('refresh', 16), t('tokenmon.collect')) as HTMLButtonElement;
  collectBtn.addEventListener('click', () => void (async () => {
    collectBtn.disabled = true; collectBtn.textContent = t('tokenmon.collect.running');
    try { const r = await api.post<{ inserted: number }>('/api/token-usage/collect'); collectBtn.textContent = t('tokenmon.collect.done', { N: r.inserted }); setTimeout(() => reload(), 800); }
    catch { collectBtn.textContent = t('tokenmon.collect.error'); setTimeout(() => { collectBtn.disabled = false; collectBtn.textContent = t('tokenmon.collect'); }, 1500); }
  })());

  const minInput = h('input', { type: 'number', class: 'tm-min', value: String(minTokens), onchange: (e: Event) => { minTokens = Number((e.target as HTMLInputElement).value) || 0; void loadDetails(); } }) as HTMLInputElement;
  let searchTimer: number | undefined;
  const searchInput = h('input', { type: 'text', class: 'tm-search', placeholder: t('tokenmon.details.search'), value: searchQuery, oninput: (e: Event) => { searchQuery = (e.target as HTMLInputElement).value; if (searchTimer) clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void loadDetails(), 400); } }) as HTMLInputElement;

  const th = (col: SortCol, key: string): HTMLElement => {
    const arrow = sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return h('th', { class: 'sortable', onclick: () => { if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc'; else { sortCol = col; sortDir = col === 'agent' ? 'asc' : 'desc'; } renderDetails(); } }, t(key) + arrow);
  };

  mount(host,
    h('div', { class: 'page-header tm-header' },
      h('div', null, h('h1', null, t('tokenmon.title')), h('p', { class: 'subtitle' }, t('tokenmon.subtitle'))),
      h('div', { class: 'tm-controls' }, periodSel, agentSel, collectBtn),
    ),
    summaryRow,
    h('div', { class: 'tm-budgets' }, budgetCard('5h', budget5, '#33c2a6'), budgetCard('weekly', budgetWk, '#e8b84b')),
    h('div', { class: 'panel tm-chart-card' }, h('div', { class: 'panel-title' }, t('tokenmon.timeline.heading')), h('div', { class: 'tm-canvas-wrap' }, canvas, tooltip)),
    h('div', { class: 'panel tm-details-card' },
      h('div', { class: 'tm-details-head' }, h('div', { class: 'panel-title' }, t('tokenmon.details.heading')), h('label', { class: 'tm-min-label' }, t('tokenmon.details.minTokens'), minInput)),
      h('div', { class: 'tm-details-bar' }, searchInput, countLabel),
      h('div', { class: 'tm-table-wrap' }, h('table', { class: 'tm-table' },
        h('thead', null, h('tr', null, th('time', 'tokenmon.col.time'), th('agent', 'tokenmon.col.agent'), th('input', 'tokenmon.col.input'), th('output', 'tokenmon.col.output'), h('th', null, t('tokenmon.col.content')))),
        detailsBody,
      )),
    ),
  );
  drawChart();
  void loadDetails();
}

defineView('tokenmon', 'nav.tokenmon', (host, store) => { void render(host, store); });
