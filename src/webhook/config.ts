// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { SettingsStore } from '../settings/store.js';
import type { VaultStore } from '../vault/store.js';
import { sanitizeId } from '../trust/sanitize.js';

/**
 * Generic-webhook plugin config (FIX-plugin-webhook).
 *
 * Two declarative lists, both operator-managed:
 *  - inbound HOOKS: { id, mapping } in settings; the per-hook HMAC SECRET lives in
 *    the vault (vault id `webhook-hook-<id>`), NEVER in settings and NEVER logged.
 *  - outbound TARGETS: { name, url, events } in settings; an optional auth header
 *    SECRET (e.g. a bearer the buyer's endpoint expects) lives in the vault
 *    (vault id `webhook-target-<name>`).
 *
 * Settings holds only NON-secret structure (the SettingsStore contract); the
 * secrets stay encrypted in the vault. The config is read fresh on every request
 * so an operator edit applies without a restart.
 */

/** The single inbound action a mapping resolves to. */
export type WebhookActionKind = 'kanban_card' | 'agent_message' | 'idea' | 'daily_log';

/** A declarative field map: target field <- a `$.json.path` (or a literal `=text`). */
export type WebhookFieldMap = Record<string, string>;

export interface WebhookMapping {
  action: WebhookActionKind;
  /** Field templates resolved against the (untrusted) inbound payload. */
  fields: WebhookFieldMap;
  /** For agent_message/daily_log: which agent receives it (sanitized). */
  agentId?: string;
}

export interface WebhookHook {
  id: string;
  mapping: WebhookMapping;
}

/** A configured, NAMED outbound target. Outbound is never an arbitrary URL. */
export interface WebhookTarget {
  name: string;
  url: string;
  /** System events this target subscribes to (empty = manual webhook_post only). */
  events: WebhookEventKind[];
  /** Name of an HTTP header to carry the auth secret (e.g. 'authorization'). */
  authHeader?: string;
}

/** The system events the bus can publish to outbound targets. */
export const WEBHOOK_EVENT_KINDS = [
  'kanban.move',
  'kanban.card_done',
  'idea.created',
  'agent.finished',
  'panel.transition',
  'agent.stuck',
  'deploy.diverged',
] as const;
export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

const HOOKS_KEY = 'webhook-hooks';
const TARGETS_KEY = 'webhook-targets';

/** A hook id / target name must be a single safe slug — it becomes a path/vault segment. */
export const WEBHOOK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidWebhookId(id: string): boolean {
  return WEBHOOK_ID_RE.test(id);
}

export function hookSecretVaultId(hookId: string): string {
  return `webhook-hook-${hookId}`;
}
export function targetSecretVaultId(name: string): string {
  return `webhook-target-${name}`;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseEvents(v: unknown): WebhookEventKind[] {
  if (!Array.isArray(v)) return [];
  const known = new Set<string>(WEBHOOK_EVENT_KINDS);
  return v.filter((e): e is WebhookEventKind => typeof e === 'string' && known.has(e));
}

function parseMapping(v: unknown): WebhookMapping | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const action = asString(o.action) as WebhookActionKind;
  if (!['kanban_card', 'agent_message', 'idea', 'daily_log'].includes(action)) return undefined;
  const fields: WebhookFieldMap = {};
  if (typeof o.fields === 'object' && o.fields !== null) {
    for (const [k, val] of Object.entries(o.fields as Record<string, unknown>)) {
      if (typeof val === 'string') fields[k] = val;
    }
  }
  const mapping: WebhookMapping = { action, fields };
  const agentId = sanitizeId(asString(o.agentId));
  if (agentId !== '') mapping.agentId = agentId;
  return mapping;
}

/**
 * Read the configured inbound hooks. Malformed rows are dropped (fail closed)
 * rather than throwing — a bad stored value can never break inbound dispatch.
 */
export function readHooks(settings: SettingsStore): WebhookHook[] {
  let raw: unknown;
  try {
    raw = JSON.parse(settings.get(HOOKS_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: WebhookHook[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const id = asString(o.id);
    if (!isValidWebhookId(id)) continue;
    const mapping = parseMapping(o.mapping);
    if (mapping === undefined) continue;
    out.push({ id, mapping });
  }
  return out;
}

export function findHook(settings: SettingsStore, hookId: string): WebhookHook | undefined {
  return readHooks(settings).find((h) => h.id === hookId);
}

export function writeHooks(settings: SettingsStore, hooks: WebhookHook[]): void {
  settings.set(HOOKS_KEY, JSON.stringify(hooks));
}

export function readTargets(settings: SettingsStore): WebhookTarget[] {
  let raw: unknown;
  try {
    raw = JSON.parse(settings.get(TARGETS_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: WebhookTarget[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const name = asString(o.name);
    const url = asString(o.url);
    if (!isValidWebhookId(name) || url === '') continue;
    const target: WebhookTarget = { name, url, events: parseEvents(o.events) };
    const authHeader = asString(o.authHeader).trim();
    if (authHeader !== '') target.authHeader = authHeader;
    out.push(target);
  }
  return out;
}

export function findTarget(settings: SettingsStore, name: string): WebhookTarget | undefined {
  return readTargets(settings).find((tg) => tg.name === name);
}

export function writeTargets(settings: SettingsStore, targets: WebhookTarget[]): void {
  settings.set(TARGETS_KEY, JSON.stringify(targets));
}

/** Operator allowlist of exact hostnames outbound webhooks may reach (newline/comma sep). */
export function readOutboundAllowlist(settings: SettingsStore): string {
  return settings.get('webhook-outbound-allowlist') ?? '';
}

/** Resolve a hook's HMAC secret from the vault (undefined when unset). */
export function hookSecret(vault: VaultStore, hookId: string): string | undefined {
  return vault.getSecretValue(hookSecretVaultId(hookId));
}

/** Resolve a target's optional auth-header secret from the vault. */
export function targetSecret(vault: VaultStore, name: string): string | undefined {
  return vault.getSecretValue(targetSecretVaultId(name));
}
