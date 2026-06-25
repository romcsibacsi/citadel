// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { WebhookMapping } from './config.js';
import { frameDelivery } from '../trust/frame.js';
import { PROCESS_SENTINEL } from '../core/ids.js';

/**
 * Declarative inbound mapping (FIX-plugin-webhook). An inbound payload is mapped
 * to ONE action via a tiny template language — NO code from the payload is ever
 * executed.
 *
 * A field template is one of:
 *  - `$.a.b.c`   → the JSON value at that path in the (untrusted) payload, stringified;
 *  - `$.a.b[0]`  → array index access is supported in the path;
 *  - `=literal`  → a literal string (the leading `=` is stripped);
 *  - anything else → a literal string.
 *
 * Resolution is a pure path walk: it indexes plain objects/arrays only and never
 * calls functions, getters defined by the payload (JSON has none), or `eval`.
 *
 * The payload is UNTRUSTED. Any text that reaches an agent (a message body, a
 * card description) is wrapped in the `untrusted` trust frame so the agent treats
 * it strictly as data — never as instructions (SPEC §6).
 */

/** Parse a `$.a.b[0].c` path into its segments (strings + numeric indices). */
function parsePath(expr: string): Array<string | number> {
  const body = expr.slice(2); // drop the leading "$."
  const out: Array<string | number> = [];
  for (const part of body.split('.')) {
    if (part === '') continue;
    // split off any [n] index suffixes, e.g. items[0][1]
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (m === null) {
      out.push(part);
      continue;
    }
    if (m[1] !== undefined && m[1] !== '') out.push(m[1]);
    const idx = m[2] ?? '';
    for (const im of idx.matchAll(/\[(\d+)\]/g)) out.push(Number(im[1]));
  }
  return out;
}

/** Walk a path over a plain JSON value. Returns undefined on any miss. */
function walk(payload: unknown, path: Array<string | number>): unknown {
  let cur: unknown = payload;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      // own-property only — never traverse the prototype chain
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Resolve a single field template against the payload (pure; no code runs). */
export function resolveTemplate(template: string, payload: unknown): string {
  if (template.startsWith('=')) return template.slice(1);
  if (template.startsWith('$.')) return stringify(walk(payload, parsePath(template)));
  return template;
}

/** Resolve every field template in a mapping into concrete strings. */
export function resolveFields(mapping: WebhookMapping, payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, template] of Object.entries(mapping.fields)) {
    out[field] = resolveTemplate(template, payload);
  }
  return out;
}

/**
 * Frame a resolved text as UNTRUSTED external data before it reaches an agent.
 * `hookId` becomes the (already-validated, slug) sender id in the frame.
 */
export function frameUntrusted(text: string, hookId: string): string {
  return frameDelivery({ body: text, tier: 'untrusted', senderId: `webhook-${hookId}`, sentinel: PROCESS_SENTINEL });
}

/**
 * The four sink actions, injected so the dispatcher stays decoupled from the
 * concrete stores (the route wires the real ones; tests pass direct stores).
 * Each returns a small descriptor of what it created (for the inbound response).
 */
export interface WebhookActions {
  createKanbanCard: (input: { title: string; description?: string; assignee?: string; project?: string }) => { id: number };
  messageAgent: (input: { agentId: string; body: string }) => { id: number };
  createIdea: (input: { title: string; description?: string }) => { id: number };
  appendDailyLog: (input: { agentId: string; line: string }) => void;
}

export interface DispatchResult {
  action: WebhookMapping['action'];
  ref?: number;
}

/**
 * Run a hook's mapping against an (untrusted) payload, producing exactly one
 * action. All free text that lands in an agent's context is trust-framed.
 */
export function dispatchMapping(
  hookId: string,
  mapping: WebhookMapping,
  payload: unknown,
  actions: WebhookActions,
): DispatchResult {
  const f = resolveFields(mapping, payload);
  switch (mapping.action) {
    case 'kanban_card': {
      const title = (f.title ?? '').trim() || `webhook ${hookId}`;
      const card = actions.createKanbanCard({
        // a card title is operator-facing chrome, not an instruction channel, but the
        // DESCRIPTION (the free-form payload echo) is framed as untrusted.
        title: title.slice(0, 200),
        ...(f.description !== undefined ? { description: frameUntrusted(f.description, hookId) } : {}),
        ...(f.assignee !== undefined && f.assignee !== '' ? { assignee: f.assignee } : {}),
        ...(f.project !== undefined && f.project !== '' ? { project: f.project } : {}),
      });
      return { action: mapping.action, ref: card.id };
    }
    case 'agent_message': {
      const agentId = mapping.agentId ?? '';
      if (agentId === '') throw new Error('agent_message mapping requires an agentId');
      // NOTE: do NOT pre-frame here — the messaging delivery pipeline frames the
      // body at delivery time (the `webhook-<id>` sender resolves to an unknown
      // peer → the untrusted frame). Pre-framing would double-wrap it.
      const msg = actions.messageAgent({ agentId, body: f.body ?? f.text ?? '' });
      return { action: mapping.action, ref: msg.id };
    }
    case 'idea': {
      const title = (f.title ?? '').trim() || `webhook idea ${hookId}`;
      const idea = actions.createIdea({
        title: title.slice(0, 200),
        ...(f.description !== undefined ? { description: frameUntrusted(f.description, hookId) } : {}),
      });
      return { action: mapping.action, ref: idea.id };
    }
    case 'daily_log': {
      const agentId = mapping.agentId ?? '';
      if (agentId === '') throw new Error('daily_log mapping requires an agentId');
      actions.appendDailyLog({ agentId, line: frameUntrusted(f.line ?? f.text ?? '', hookId) });
      return { action: mapping.action };
    }
  }
}
