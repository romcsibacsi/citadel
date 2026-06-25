// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { splitKeywords, type Memory, type Tier } from './model.js';

/**
 * Force-directed memory graph (PROMPT-08 §6.7) on a canvas. Nodes are memories,
 * edges connect memories that share a keyword (width ∝ shared count), nodes are
 * colored by tier and softly clustered toward their tier centroid. Supports
 * zoom-to-cursor, pan, node drag, hover, click (details) and double-click (edit),
 * plus live search highlight. Visual polish is intentionally restrained — the
 * spec defers exact rendering to the design system; the requirement is a readable,
 * interactive, tier-clustered cloud.
 */

const TIER_COLOR: Record<Tier, string> = { hot: '#ff5d5d', warm: '#f0822e', cold: '#34a8d6', shared: '#e6b249' };

interface Node { m: Memory; x: number; y: number; vx: number; vy: number; r: number; deg: number; kw: Set<string> }
interface Edge { a: Node; b: Node; strength: number }

export interface GraphController { destroy(): void; setSearch(q: string): void }

export function renderGraph(
  canvas: HTMLCanvasElement,
  memories: Memory[],
  opts: {
    onClick: (m: Memory) => void;
    onDblClick: (m: Memory) => void;
    onHover: (m: Memory | null, clientX: number, clientY: number, connections: number) => void;
    onZoom: (pct: number) => void;
  },
): GraphController {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;

  // --- build nodes + edges ---
  const nodes: Node[] = memories.map((m, i) => {
    const a = (i / memories.length) * Math.PI * 2;
    return { m, x: Math.cos(a) * 160, y: Math.sin(a) * 160, vx: 0, vy: 0, r: 7, deg: 0, kw: new Set(splitKeywords(m.keywords).map((k) => k.toLowerCase())) };
  });
  const edges: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let shared = 0;
      for (const k of nodes[i]!.kw) if (nodes[j]!.kw.has(k)) shared++;
      if (shared > 0) { edges.push({ a: nodes[i]!, b: nodes[j]!, strength: shared }); nodes[i]!.deg += shared; nodes[j]!.deg += shared; }
    }
  }
  for (const n of nodes) n.r = 6 + Math.min(10, n.deg * 1.5);

  // --- camera ---
  let scale = 1, ox = 0, oy = 0;
  let query = '';
  let hoverNode: Node | null = null;
  let dragNode: Node | null = null;
  let panning = false;
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0, downAt = 0;

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ox = rect.width / 2;
    oy = rect.height / 2;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const toWorld = (cx: number, cy: number): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: (cx - rect.left - ox) / scale, y: (cy - rect.top - oy) / scale };
  };
  const nodeAt = (cx: number, cy: number): Node | null => {
    const w = toWorld(cx, cy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if ((n.x - w.x) ** 2 + (n.y - w.y) ** 2 <= (n.r + 4) ** 2) return n;
    }
    return null;
  };

  // --- simulation ---
  const tierCentroid: Record<Tier, { x: number; y: number }> = { hot: { x: -200, y: -150 }, warm: { x: 200, y: -150 }, cold: { x: -200, y: 150 }, shared: { x: 200, y: 150 } };
  const step = (alpha: number): void => {
    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const f = (2400 / d2) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    // springs
    for (const e of edges) {
      let dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = ((d - 80) * 0.02 * Math.min(3, e.strength)) * alpha;
      dx /= d; dy /= d;
      e.a.vx += dx * f; e.a.vy += dy * f; e.b.vx -= dx * f; e.b.vy -= dy * f;
    }
    // centering + tier clustering
    for (const n of nodes) {
      n.vx += (-n.x * 0.002) * alpha; n.vy += (-n.y * 0.002) * alpha;
      const c = tierCentroid[n.m.category];
      n.vx += (c.x - n.x) * 0.004 * alpha; n.vy += (c.y - n.y) * 0.004 * alpha;
    }
    // integrate
    for (const n of nodes) {
      if (n === dragNode) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
    }
  };
  for (let i = 0; i < 160; i++) step(0.6); // pre-settle

  // --- render ---
  let raf = 0, phase = 0;
  const draw = (): void => {
    const rect = canvas.getBoundingClientRect();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    // dotted grid
    ctx.fillStyle = 'rgba(127,127,150,0.10)';
    for (let gx = 0; gx < rect.width; gx += 26) for (let gy = 0; gy < rect.height; gy += 26) { ctx.beginPath(); ctx.arc(gx, gy, 0.8, 0, Math.PI * 2); ctx.fill(); }
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    const matches = (n: Node): boolean => {
      if (query === '') return true;
      return n.m.content.toLowerCase().includes(query) || n.m.keywords.toLowerCase().includes(query) || n.m.agentId.toLowerCase().includes(query);
    };
    const neighbors = new Set<Node>();
    if (hoverNode) { neighbors.add(hoverNode); for (const e of edges) { if (e.a === hoverNode) neighbors.add(e.b); if (e.b === hoverNode) neighbors.add(e.a); } }

    // edges
    phase += 0.03;
    for (const e of edges) {
      const dim = (hoverNode && !(neighbors.has(e.a) && neighbors.has(e.b))) || (query !== '' && !(matches(e.a) && matches(e.b)));
      ctx.strokeStyle = dim ? 'rgba(127,127,150,0.06)' : `rgba(150,160,200,${0.18 + 0.08 * Math.sin(phase)})`;
      ctx.lineWidth = Math.min(3, e.strength) / scale;
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    // nodes
    for (const n of nodes) {
      const dim = (hoverNode && !neighbors.has(n)) || (query !== '' && !matches(n));
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = TIER_COLOR[n.m.category];
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      if (!dim && (n === hoverNode || query !== '')) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / scale; ctx.stroke(); }
      // label
      ctx.globalAlpha = dim ? 0.25 : 0.9;
      ctx.fillStyle = 'rgba(220,225,240,0.92)';
      ctx.font = `${11 / scale}px sans-serif`;
      ctx.fillText(n.m.content.replace(/\s+/g, ' ').slice(0, 25), n.x + n.r + 3, n.y + 3);
    }
    ctx.globalAlpha = 1;
    step(0.04); // gentle ongoing settle
    raf = requestAnimationFrame(draw);
  };
  draw();

  // --- interaction ---
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const before = toWorld(e.clientX, e.clientY);
    scale = Math.max(0.25, Math.min(3, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    const after = toWorld(e.clientX, e.clientY);
    ox += (after.x - before.x) * scale; oy += (after.y - before.y) * scale;
    opts.onZoom(Math.round(scale * 100));
  };
  const onDown = (e: MouseEvent): void => {
    downX = e.clientX; downY = e.clientY; downAt = Date.now();
    const n = nodeAt(e.clientX, e.clientY);
    if (n) { dragNode = n; } else { panning = true; }
    lastX = e.clientX; lastY = e.clientY;
  };
  const onMove = (e: MouseEvent): void => {
    if (dragNode) { const w = toWorld(e.clientX, e.clientY); dragNode.x = w.x; dragNode.y = w.y; return; }
    if (panning) { ox += e.clientX - lastX; oy += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; return; }
    const n = nodeAt(e.clientX, e.clientY);
    hoverNode = n;
    canvas.style.cursor = n ? 'pointer' : 'grab';
    opts.onHover(n?.m ?? null, e.clientX, e.clientY, n ? n.deg : 0);
  };
  const onUp = (e: MouseEvent): void => {
    const moved = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY);
    const n = dragNode;
    dragNode = null; panning = false;
    if (n && moved < 4 && Date.now() - downAt < 400) opts.onClick(n.m);
  };
  const onDbl = (e: MouseEvent): void => { const n = nodeAt(e.clientX, e.clientY); if (n) opts.onDblClick(n.m); };

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('dblclick', onDbl);

  return {
    destroy(): void {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
    },
    setSearch(qStr: string): void { query = qStr.trim().toLowerCase(); },
  };
}
