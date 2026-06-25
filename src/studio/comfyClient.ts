// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import type { Graph } from './graphs.js';

/**
 * Minimal ComfyUI HTTP client (FIX-studio-local README §2) — the only endpoints
 * Studio uses against the operator's LOCAL GPU server. The base URL is resolved
 * at call time (a config/vault change applies without a restart) and every
 * request carries a ~60s timeout so a hung-but-accepted socket (a real failure
 * mode on this box) can't block forever. Never throws on a probe (reachable()).
 */

const log = createLogger('studio.comfy');

export class ComfyUnavailable extends Error {}

export interface ComfyOutputFile { filename: string; subfolder: string; type: string; kind: 'image' | 'video' }
export interface ComfyHistory { done: boolean; error: boolean; outputs: ComfyOutputFile[] }

export interface ComfyClientOpts {
  /** Resolve the base URL at call time; undefined/'' → not configured. */
  baseUrl: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ComfyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly opts: ComfyClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  base(): string {
    const u = (this.opts.baseUrl() ?? '').trim().replace(/\/+$/, '');
    if (u === '') throw new ComfyUnavailable('ComfyUI base URL is not configured (set comfy_url).');
    return u;
  }

  private async req(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.base()}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reachability probe used by status + the wake poll. Never throws. */
  async reachable(): Promise<boolean> {
    try {
      const res = await this.req('/system_stats', {}, 5_000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async systemStats(): Promise<{ ok: boolean; device?: string; version?: string }> {
    try {
      const res = await this.req('/system_stats', {}, 5_000);
      if (!res.ok) return { ok: false };
      const j = (await res.json()) as { system?: { comfyui_version?: string }; devices?: Array<{ name?: string }> };
      const out: { ok: boolean; device?: string; version?: string } = { ok: true };
      const d = j.devices?.[0]?.name;
      if (typeof d === 'string') out.device = d;
      const v = j.system?.comfyui_version;
      if (typeof v === 'string') out.version = v;
      return out;
    } catch {
      return { ok: false };
    }
  }

  /** Available checkpoint names (CheckpointLoaderSimple.input.required.ckpt_name[0]). */
  async checkpoints(): Promise<string[]> {
    const res = await this.req('/object_info/CheckpointLoaderSimple', {});
    if (!res.ok) return [];
    const j = (await res.json()) as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } } };
    const names = j.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    return Array.isArray(names) ? (names.filter((n) => typeof n === 'string') as string[]) : [];
  }

  /**
   * Generic option list for a node's combo field (FIX-plugin-comfy-workflows):
   * /object_info/<NodeClass>.input.required.<field>[0] is the array of choices
   * (LoraLoader.lora_name, UpscaleModelLoader.model_name, ControlNetLoader.control_net_name).
   * Returns [] when the node/field is absent or the server is unreachable (never throws).
   */
  async nodeOptions(nodeClass: string, field: string): Promise<string[]> {
    try {
      const res = await this.req(`/object_info/${encodeURIComponent(nodeClass)}`, {}, 10_000);
      if (!res.ok) return [];
      const j = (await res.json()) as Record<string, { input?: { required?: Record<string, unknown[]> } }>;
      const arr = j[nodeClass]?.input?.required?.[field]?.[0];
      return Array.isArray(arr) ? (arr.filter((n) => typeof n === 'string') as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Whether the server has a given custom node installed (README §3a). ComfyUI
   * answers /object_info/<NodeClass> with `{ "<NodeClass>": {...} }` when present,
   * and 404 / `{}` when absent. Used to detect a missing InstantID install and
   * give a clear message instead of a cryptic /prompt 400. Never throws.
   */
  async hasNode(nodeClass: string): Promise<boolean> {
    try {
      const res = await this.req(`/object_info/${encodeURIComponent(nodeClass)}`, {}, 10_000);
      if (!res.ok) return false;
      const j = (await res.json()) as Record<string, unknown>;
      return j !== null && typeof j === 'object' && Object.prototype.hasOwnProperty.call(j, nodeClass);
    } catch {
      return false;
    }
  }

  /** Submit a graph; returns the prompt_id. Throws on validation (node_errors). */
  async submit(graph: Graph, clientId: string): Promise<string> {
    const res = await this.req('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ComfyUI /prompt → HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const j = (await res.json()) as { prompt_id?: unknown; node_errors?: unknown };
    if (j.node_errors !== null && typeof j.node_errors === 'object' && Object.keys(j.node_errors as object).length > 0) {
      throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(j.node_errors).slice(0, 300)}`);
    }
    if (typeof j.prompt_id !== 'string' || j.prompt_id === '') throw new Error('ComfyUI did not return a prompt id.');
    return j.prompt_id;
  }

  /** Poll one run's history. null = not finished yet. */
  async history(promptId: string): Promise<ComfyHistory | null> {
    const res = await this.req(`/history/${encodeURIComponent(promptId)}`, {});
    if (!res.ok) throw new Error(`ComfyUI /history → HTTP ${res.status}`);
    const j = (await res.json()) as Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: unknown[]; gifs?: unknown[]; videos?: unknown[] }> }>;
    const entry = j[promptId];
    if (entry === undefined) return null;
    const error = entry.status?.status_str === 'error';
    const outputs: ComfyOutputFile[] = [];
    const take = (arr: unknown[] | undefined, kind: 'image' | 'video'): void => {
      for (const f of arr ?? []) {
        const o = f as { filename?: unknown; subfolder?: unknown; type?: unknown };
        if (typeof o.filename === 'string' && o.filename !== '') {
          outputs.push({ filename: o.filename, subfolder: typeof o.subfolder === 'string' ? o.subfolder : '', type: typeof o.type === 'string' ? o.type : 'output', kind });
        }
      }
    };
    for (const node of Object.values(entry.outputs ?? {})) {
      take(node.images, 'image');
      take(node.gifs, 'video');
      take(node.videos, 'video');
    }
    const done = entry.status?.completed === true || outputs.length > 0;
    return { done, error, outputs };
  }

  async view(f: { filename: string; subfolder: string; type: string }): Promise<Buffer> {
    const qs = `filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${encodeURIComponent(f.type)}`;
    const res = await this.req(`/view?${qs}`, {});
    if (!res.ok) throw new Error(`ComfyUI /view → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Upload a local image for i2v; returns ComfyUI's stored {name, subfolder}. */
  async uploadImage(name: string, bytes: Buffer): Promise<{ name: string; subfolder: string }> {
    const fd = new FormData();
    fd.set('image', new Blob([new Uint8Array(bytes)]), name);
    fd.set('overwrite', 'true');
    const res = await this.req('/upload/image', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`ComfyUI /upload/image → HTTP ${res.status}`);
    const j = (await res.json()) as { name?: string; subfolder?: string };
    return { name: typeof j.name === 'string' ? j.name : name, subfolder: typeof j.subfolder === 'string' ? j.subfolder : '' };
  }

  /** A subfolder/name reference for a LoadImage node from an upload result. */
  static ref(up: { name: string; subfolder: string }): string {
    return up.subfolder !== '' ? `${up.subfolder}/${up.name}` : up.name;
  }
}

export { log as comfyLog };
