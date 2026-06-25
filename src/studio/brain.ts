// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import type { Mode } from './service.js';

/**
 * Studio "brain" (FIX-studio-brain, README §6): a local ollama `/api/chat` native
 * tool-calling loop that expands a short (often Hungarian) request into a detailed
 * ENGLISH prompt and picks the right media tool BEFORE rendering — exactly what the
 * old Studio did. It is an OPT-IN enhancement: only runs when `ollama_url` +
 * `ollama_model` are set and reachable; otherwise the caller falls back to the raw
 * prompt. Everything talks to the CONFIGURED `ollama_url` — never a hardcoded host.
 */

const log = createLogger('studio.brain');

export class BrainError extends Error {}

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface BrainResult { reply: string; files: string[]; log: string[]; toolCalls: number }
export interface BrainOptions {
  ollamaUrl: string;
  model: string;
  system: string;
  tools: OllamaTool[];
  fetchImpl: typeof fetch;
  /** Run a tool the model picked; returns produced files + log lines (throws are fed back to the model). */
  execute: (name: string, args: Record<string, unknown>) => Promise<{ files: string[]; log: string[] }>;
  now: () => number;
  budgetMs?: number;
  maxRounds?: number;
  perCallTimeoutMs?: number;
}

function normBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
function isHttp(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url.trim());
}

/** ollama model names from /api/tags — null when the host is unreachable (preflight). */
export async function ollamaModels(ollamaUrl: string, fetchImpl: typeof fetch, timeoutMs = 4000): Promise<string[] | null> {
  const base = normBase(ollamaUrl);
  if (!isHttp(base)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { models?: Array<{ name?: unknown }> };
    return (j.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(a: unknown): Record<string, unknown> {
  if (a !== null && typeof a === 'object') return a as Record<string, unknown>;
  if (typeof a === 'string') { try { return JSON.parse(a) as Record<string, unknown>; } catch { return {}; } }
  return {};
}

interface ChatMessage { role: string; content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }

async function chat(base: string, o: BrainOptions, messages: ChatMessage[]): Promise<ChatMessage> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.perCallTimeoutMs ?? 180_000);
  try {
    const res = await o.fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: o.model, messages, tools: o.tools, stream: false }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new BrainError(`ollama /api/chat → HTTP ${res.status}`);
    const j = (await res.json()) as { message?: ChatMessage };
    return j.message ?? { role: 'assistant' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the tool-calling loop. Bounded by maxRounds + a wall-clock budget; a tool
 * that throws is reported back to the model (so it can adjust) rather than killing
 * the run. The honest summary/files come from the tool RESULTS, not the model's prose.
 */
export async function runBrain(request: string, o: BrainOptions): Promise<BrainResult> {
  const base = normBase(o.ollamaUrl);
  const budgetMs = o.budgetMs ?? 180_000;
  const maxRounds = o.maxRounds ?? 10;
  const start = o.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: o.system },
    { role: 'user', content: request },
  ];
  const files: string[] = [];
  const logLines: string[] = [];
  let toolCalls = 0;
  let attempts = 0;
  const maxAttempts = maxRounds * 3; // hard ceiling on total tool executions (defence)
  let reply = '';
  for (let round = 0; round < maxRounds; round++) {
    if (o.now() - start > budgetMs) { logLines.push('brain: time budget exhausted'); break; }
    if (attempts >= maxAttempts) { logLines.push('brain: tool-call ceiling reached'); break; }
    let msg: ChatMessage;
    try {
      msg = await chat(base, o, messages); // a chat failure/timeout ends the loop gracefully (no uncaught reject)
    } catch (err) {
      logLines.push(`brain: chat failed (${err instanceof Error ? err.message : String(err)}) — stopping the loop`);
      break;
    }
    messages.push(msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      reply = typeof msg.content === 'string' ? msg.content.trim() : '';
      break;
    }
    for (const c of calls) {
      attempts += 1;
      const name = String(c.function?.name ?? '');
      const args = parseArgs(c.function?.arguments);
      logLines.push(`brain → ${name}(${JSON.stringify(args).slice(0, 200)})`);
      try {
        const r = await o.execute(name, args);
        files.push(...r.files);
        logLines.push(...r.log);
        toolCalls += 1;
        messages.push({ role: 'tool', content: JSON.stringify({ ok: true, files: r.files }) });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logLines.push(`brain ✗ ${name}: ${m}`);
        messages.push({ role: 'tool', content: JSON.stringify({ ok: false, error: m }) });
      }
    }
  }
  log.info('brain run complete', { toolCalls, files: files.length });
  return { reply, files, log: logLines, toolCalls };
}

// --- the studio toolset + system prompt (mode-restricted) -------------------

const NUM = { type: 'number' } as const;
const STR = { type: 'string' } as const;
function fn(name: string, description: string, props: Record<string, unknown>, required: string[]): OllamaTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } };
}

const IMAGE_TOOLS: OllamaTool[] = [
  fn('generate_image', 'Render an image from a detailed English prompt (SDXL).',
    { prompt: STR, negative: STR, width: NUM, height: NUM, steps: NUM, cfg: NUM, seed: NUM }, ['prompt']),
  fn('generate_image_with_face', 'Character-consistent image: render the SAME identity from a reference face photo (InstantID).',
    { reference_image: STR, prompt: STR, negative: STR, weight: NUM, seed: NUM }, ['reference_image', 'prompt']),
];
const VIDEO_TOOLS: OllamaTool[] = [
  fn('generate_video', 'Render a video from a detailed English prompt (text→video). Describe motion AND a camera move.',
    { prompt: STR, negative: STR, seconds: NUM, width: NUM, height: NUM, steps: NUM, cfg: NUM, seed: NUM }, ['prompt']),
  fn('animate_image', 'Animate a still image into a video (image→video) from a start frame + a motion prompt.',
    { source_image: STR, prompt: STR, seconds: NUM, seed: NUM }, ['source_image', 'prompt']),
  fn('images_to_video', 'Make a slideshow video from images (N seconds per image).',
    { images: { type: 'array', items: STR }, seconds_per_image: NUM }, ['images']),
  fn('concat_videos', 'Concatenate two or more videos into one.', { videos: { type: 'array', items: STR } }, ['videos']),
  fn('trim_video', 'Trim a video to a [start, start+duration] window.', { video: STR, start: NUM, duration: NUM }, ['video']),
  fn('extract_frame', 'Extract a single frame from a video as a PNG.', { video: STR, at: NUM }, ['video']),
];

export function studioBrainTools(mode: Mode): OllamaTool[] {
  return mode === 'video' ? VIDEO_TOOLS : IMAGE_TOOLS;
}
export const GEN_TOOLS = new Set(['generate_image', 'generate_image_with_face', 'generate_video', 'animate_image']);
export function toolAllowed(mode: Mode, name: string): boolean {
  return studioBrainTools(mode).some((t) => t.function.name === name);
}

export function studioBrainSystem(mode: Mode): string {
  const common = [
    'You are the Studio media director. You ALWAYS call a tool — never just chat, never ask back.',
    'ALWAYS expand the (often short, Hungarian) request into a DETAILED ENGLISH prompt. Describe subjects',
    'DESCRIPTIVELY (appearance, not proper/IP names the image model may not know — e.g. "a grey-blue',
    'cartoon cat chasing a small brown mouse, a brown bulldog chasing the cat"), plus lighting and quality.',
    'Honest: report only what the tool RESULT returns. Do NOT restate the user\'s adjectives',
    '("hyperrealistic", "cinematic", "beautiful", "stunning") as achieved facts in your summary —',
    'describe only what was actually rendered, never assert a quality you did not verify.',
    'One hard rule: never anything involving minors.',
  ];
  const perMode = mode === 'video'
    ? [
        'MODE = VIDEO. For every video, describe the MOTION and an explicit CAMERA MOVE (slow zoom in, orbit,',
        'pan, tracking, static). If the user gives a duration in seconds, set the `seconds` arg (not frames).',
        'No source image → generate_video (text→video); a source still → animate_image (image→video).',
        'Multi-step ("make N images then a slideshow") → call the gen tool(s) then images_to_video/concat_videos.',
      ]
    : [
        'MODE = IMAGE. Add quality cues (photorealistic, sharp, detailed) OR the requested style, and a good negative.',
        'If the user supplies a reference face, use generate_image_with_face; otherwise generate_image.',
      ];
  return [...common, ...perMode].join(' ');
}
