// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import { saveImageArtifact } from './saveImage.js';
import type { CoreTool, CoreToolContext } from './registry.js';

/**
 * `render_chart` + `render_diagram` (FIX-plugin-agent-tools §2).
 *
 * render_chart: data (labels + one or more series) + a type (bar|line|pie) → a
 * hand-built SVG, FULLY OFFLINE (no network, no npm runtime dep), saved into the
 * Files images root. Deterministic; sizes clamped.
 *
 * render_diagram: a Mermaid / Graphviz-DOT source → SVG via a LOCAL renderer
 * invoked through the injectable command runner (the ollama/comfy "config-driven
 * external command" pattern). If no renderer is configured/installed, a clear
 * "diagram renderer not installed" message — never a hang, never a crash.
 *
 * Both are pure capabilities (no requiredPermission): they touch no network and
 * write only into the contained images root.
 */

const log = createLogger('tools.charts');

const W = 800;
const H = 480;
const PAD = 48;
const MAX_POINTS = 200;
const PALETTE = ['#7c5cff', '#ff6b35', '#22c55e', '#0ea5e9', '#eab308', '#ec4899', '#14b8a6', '#f97316'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function numArr(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

interface Series { name: string; values: number[] }

function readSeries(args: Record<string, unknown>): { labels: string[]; series: Series[] } {
  const labels = strArr(args.labels).slice(0, MAX_POINTS);
  // accept either `values: number[]` (single series) or `series: [{name, values}]`
  let series: Series[] = [];
  if (Array.isArray(args.series)) {
    series = (args.series as unknown[])
      .map((s) => {
        const o = (s ?? {}) as { name?: unknown; values?: unknown };
        return { name: typeof o.name === 'string' ? o.name : '', values: numArr(o.values).slice(0, MAX_POINTS) };
      })
      .filter((s) => s.values.length > 0);
  } else if (Array.isArray(args.values)) {
    series = [{ name: typeof args.name === 'string' ? args.name : 'series', values: numArr(args.values).slice(0, MAX_POINTS) }];
  }
  return { labels, series };
}

/** Build a bar/line/pie chart SVG. Pure + deterministic. */
export function buildChartSvg(type: string, title: string, labels: string[], series: Series[]): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">`;
  const bg = `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  const titleEl = title !== '' ? `<text x="${W / 2}" y="28" text-anchor="middle" font-size="18" font-weight="bold" fill="#111">${esc(title)}</text>` : '';
  const parts: string[] = [head, bg, titleEl];

  if (type === 'pie') {
    const vals = series[0]?.values ?? [];
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0);
    const cx = W / 2;
    const cy = H / 2 + 10;
    const r = Math.min(W, H) / 3;
    if (total <= 0) {
      parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-size="14" fill="#666">no data</text>`);
    } else {
      let angle = -Math.PI / 2;
      vals.forEach((v, i) => {
        const frac = Math.max(0, v) / total;
        const next = angle + frac * 2 * Math.PI;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(next);
        const y2 = cy + r * Math.sin(next);
        const large = frac > 0.5 ? 1 : 0;
        const color = PALETTE[i % PALETTE.length];
        parts.push(`<path d="M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}"/>`);
        const lbl = labels[i];
        if (lbl !== undefined) {
          const mid = (angle + next) / 2;
          const lx = cx + (r + 18) * Math.cos(mid);
          const ly = cy + (r + 18) * Math.sin(mid);
          parts.push(`<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="middle" font-size="11" fill="#333">${esc(lbl)}</text>`);
        }
        angle = next;
      });
    }
    parts.push('</svg>');
    return parts.join('');
  }

  // bar / line share an axis frame
  const allVals = series.flatMap((s) => s.values);
  const maxV = allVals.length > 0 ? Math.max(...allVals, 0) : 1;
  const minV = Math.min(0, ...(allVals.length > 0 ? allVals : [0]));
  const span = maxV - minV || 1;
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;
  const x0 = PAD;
  const y0 = H - PAD;
  const yOf = (v: number): number => y0 - ((v - minV) / span) * plotH;
  // axes
  parts.push(`<line x1="${x0}" y1="${PAD}" x2="${x0}" y2="${y0}" stroke="#999" stroke-width="1"/>`);
  parts.push(`<line x1="${x0}" y1="${y0}" x2="${W - PAD}" y2="${y0}" stroke="#999" stroke-width="1"/>`);

  const n = Math.max(1, Math.max(...series.map((s) => s.values.length), labels.length));
  if (type === 'bar') {
    const groupW = plotW / n;
    const barW = (groupW * 0.8) / Math.max(1, series.length);
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      s.values.forEach((v, i) => {
        const bx = x0 + i * groupW + groupW * 0.1 + si * barW;
        const by = yOf(v);
        const bh = y0 - by;
        parts.push(`<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(0, bh).toFixed(2)}" fill="${color}"/>`);
      });
    });
  } else {
    // line
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const step = plotW / Math.max(1, n - 1);
      const pts = s.values.map((v, i) => `${(x0 + i * step).toFixed(2)},${yOf(v).toFixed(2)}`).join(' ');
      parts.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`);
    });
  }
  // x labels
  labels.forEach((lbl, i) => {
    const lx = x0 + (i + 0.5) * (plotW / n);
    parts.push(`<text x="${lx.toFixed(2)}" y="${y0 + 16}" text-anchor="middle" font-size="10" fill="#444">${esc(lbl)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** The `render_chart` core tool — offline SVG, saved to the images root. */
export function makeRenderChartTool(): CoreTool {
  return {
    name: 'render_chart',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'line', 'pie'] },
        title: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        values: { type: 'array', items: { type: 'number' }, description: 'single-series shorthand' },
        series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } } } },
      },
      required: ['type'],
    },
    run: async (args: Record<string, unknown>, ctx: CoreToolContext): Promise<unknown> => {
      const type = typeof args.type === 'string' ? args.type.toLowerCase() : '';
      if (type !== 'bar' && type !== 'line' && type !== 'pie') throw new Error("type must be one of bar|line|pie");
      const { labels, series } = readSeries(args);
      if (series.length === 0) throw new Error('no numeric data — provide `values: number[]` or `series: [{ values }]`');
      const title = typeof args.title === 'string' ? args.title.slice(0, 200) : '';
      const svg = buildChartSvg(type, title, labels, series);
      const name = `chart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.svg`;
      const saved = saveImageArtifact(ctx.imagesDir, name, Buffer.from(svg, 'utf8'));
      log.info('render_chart', { agent: ctx.agentId, type, points: series.reduce((a, s) => a + s.values.length, 0) });
      return { format: 'svg', ...saved, bytes: Buffer.byteLength(svg, 'utf8') };
    },
  };
}

/** Resolve the configured diagram renderer command (settings `diagram_renderer_cmd`), if any. */
function diagramRendererCmd(ctx: CoreToolContext): string | undefined {
  const raw = ctx.settings.get('diagram_renderer_cmd');
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * The `render_diagram` core tool — a Mermaid/DOT source through a LOCAL renderer
 * (config-driven command, like the comfy/ollama externals). The command template
 * must contain `{in}` and `{out}` placeholders the tool fills with temp paths.
 * Absent/unconfigured → an honest "diagram renderer not installed" message.
 */
export function makeRenderDiagramTool(): CoreTool {
  return {
    name: 'render_diagram',
    schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Mermaid or Graphviz/DOT source text' },
        format: { type: 'string', enum: ['mermaid', 'dot'] },
      },
      required: ['source'],
    },
    run: async (args: Record<string, unknown>, ctx: CoreToolContext): Promise<unknown> => {
      const source = typeof args.source === 'string' ? args.source : '';
      if (source.trim() === '') throw new Error('source is required');
      const cmdTemplate = diagramRendererCmd(ctx);
      if (cmdTemplate === undefined) {
        // the InstantID-missing pattern: clear, actionable, no crash
        throw new Error("diagram renderer not installed — set 'diagram_renderer_cmd' (a local mermaid/dot command using {in} and {out}) to enable render_diagram");
      }
      const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'diagram-'));
      const inPath = join(dir, 'in.src');
      const outPath = join(dir, 'out.svg');
      try {
        writeFileSync(inPath, source, 'utf8');
        // tokenize the operator-configured template, substituting {in}/{out} per token (NEVER a shell string)
        const tokens = cmdTemplate.split(/\s+/).filter((t) => t !== '');
        const cmd = tokens[0];
        if (cmd === undefined) throw new Error('diagram_renderer_cmd is empty');
        const cmdArgs = tokens.slice(1).map((t) => t.replace('{in}', inPath).replace('{out}', outPath));
        const r = await ctx.runner(cmd, cmdArgs);
        if (r.code !== 0) {
          throw new Error(`diagram renderer failed (exit ${r.code}): ${(r.stderr || r.stdout || '').slice(0, 300)}`);
        }
        let svg: string;
        try {
          svg = readFileSync(outPath, 'utf8');
        } catch {
          throw new Error('diagram renderer produced no output');
        }
        const name = `diagram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.svg`;
        const saved = saveImageArtifact(ctx.imagesDir, name, Buffer.from(svg, 'utf8'));
        log.info('render_diagram', { agent: ctx.agentId, bytes: Buffer.byteLength(svg, 'utf8') });
        return { format: 'svg', ...saved, bytes: Buffer.byteLength(svg, 'utf8') };
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      }
    },
  };
}
