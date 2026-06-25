// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { systemClock, isoNow, type Clock } from '../core/clock.js';

/**
 * Channel binding + pairing store (FIX-channels). Two roles:
 *
 *  - `channel_bindings`: the per-agent set of approved external chats. Its chat
 *    ids ARE the dynamic inbound allowlist — `allAllowedChatIds()` is consulted
 *    by the InboundRouter on every message, so an approval takes effect without
 *    a restart (the old static `allowedChatIds` array was frozen at boot).
 *  - `channel_pairing_requests`: unknown chats that messaged the bot. The inbound
 *    default-deny path records them (still dropping the message); the operator
 *    approves one from the Channel surface, which promotes it to a binding.
 *
 * Never stores a token or message body — only ids/labels (SPEC §7/§16).
 */

export type ChatKind = 'dm' | 'group';

export interface BoundChat {
  id: number;
  agentId: string;
  provider: string;
  chatId: string;
  label: string;
  kind: ChatKind;
  boundAt: string;
}

export interface PendingPairing {
  id: number;
  provider: string;
  chatId: string;
  user: string;
  requestedAt: string;
  /** Short code the operator can type to approve this pairing (FIX-channels-2). */
  code: string;
}

export type InviteStatus = 'active' | 'expired' | 'revoked';
export interface ChannelInvite {
  id: number;
  provider: string;
  chatId: string;
  link: string;
  name: string;
  status: InviteStatus;
  expiresAt: string | null;
  createdAt: string;
}

interface InviteRow {
  id: number;
  provider: string;
  chat_id: string;
  link: string;
  name: string;
  status: string;
  expires_at: string | null;
  created_at: string;
}

interface BindingRow {
  id: number;
  agent_id: string;
  provider: string;
  chat_id: string;
  label: string;
  kind: string;
  bound_at: string;
}

interface PairingRow {
  id: number;
  provider: string;
  chat_id: string;
  display_user: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  agent_id: string | null;
  code: string | null;
}

export class ChannelBindingStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Approved chats for one agent (the per-agent "bound chats & groups" list). */
  listForAgent(agentId: string, provider?: string): BoundChat[] {
    const rows = (
      provider === undefined
        ? this.db.prepare('SELECT * FROM channel_bindings WHERE agent_id = ? ORDER BY bound_at').all(agentId)
        : this.db.prepare('SELECT * FROM channel_bindings WHERE agent_id = ? AND provider = ? ORDER BY bound_at').all(agentId, provider)
    ) as unknown as BindingRow[];
    return rows.map(this.toBound);
  }

  /** Add (or refresh the label/kind of) an approved chat. Returns the row. */
  addBinding(agentId: string, provider: string, chatId: string, opts: { label?: string; kind?: ChatKind } = {}): BoundChat {
    const now = isoNow(this.clock);
    this.db
      .prepare(
        `INSERT INTO channel_bindings (agent_id, provider, chat_id, label, kind, bound_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, provider, chat_id) DO UPDATE SET
           label = excluded.label, kind = excluded.kind`,
      )
      .run(agentId, provider, chatId, opts.label ?? '', opts.kind ?? 'dm', now);
    const row = this.db
      .prepare('SELECT * FROM channel_bindings WHERE agent_id = ? AND provider = ? AND chat_id = ?')
      .get(agentId, provider, chatId) as unknown as BindingRow;
    return this.toBound(row);
  }

  /** Remove one approved chat by row id. Returns true when a row was removed. */
  removeBinding(id: number): boolean {
    return this.db.prepare('DELETE FROM channel_bindings WHERE id = ?').run(id).changes > 0;
  }

  /** The dynamic inbound allowlist: every approved chat id across all agents. */
  allAllowedChatIds(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT chat_id FROM channel_bindings').all() as Array<{ chat_id: string }>;
    return new Set(rows.map((r) => r.chat_id));
  }

  /**
   * Record (or re-surface) an unknown chat as a pending pairing. Idempotent per
   * (provider, chat_id); a previously-denied chat that messages again returns to
   * pending. Never throws into the inbound path's decision.
   */
  createPairing(provider: string, chatId: string, user: string): void {
    const now = isoNow(this.clock);
    const code = randomBytes(3).toString('hex').toUpperCase(); // 6-char pairing code
    this.db
      .prepare(
        `INSERT INTO channel_pairing_requests (provider, chat_id, display_user, status, requested_at, code)
         VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(provider, chat_id) DO UPDATE SET
           status = 'pending', display_user = excluded.display_user,
           requested_at = excluded.requested_at, resolved_at = NULL,
           code = COALESCE(channel_pairing_requests.code, excluded.code)`,
      )
      .run(provider, chatId, user, now, code);
  }

  /** Pending pairings (optionally for one provider). */
  listPending(provider?: string): PendingPairing[] {
    const rows = (
      provider === undefined
        ? this.db.prepare("SELECT * FROM channel_pairing_requests WHERE status = 'pending' ORDER BY requested_at").all()
        : this.db.prepare("SELECT * FROM channel_pairing_requests WHERE status = 'pending' AND provider = ? ORDER BY requested_at").all(provider)
    ) as unknown as PairingRow[];
    return rows.map((r) => ({ id: r.id, provider: r.provider, chatId: r.chat_id, user: r.display_user, requestedAt: r.requested_at, code: r.code ?? '' }));
  }

  getPairing(id: number): PairingRow | undefined {
    return this.db.prepare('SELECT * FROM channel_pairing_requests WHERE id = ?').get(id) as unknown as PairingRow | undefined;
  }

  /** Approve a PENDING pairing by its operator-typed code. Returns the binding or null. */
  approvePairingByCode(code: string, agentId: string, opts: { label?: string; kind?: ChatKind } = {}): BoundChat | null {
    const norm = code.trim().toUpperCase();
    if (norm === '') return null;
    const row = this.db
      .prepare("SELECT * FROM channel_pairing_requests WHERE status = 'pending' AND code = ?")
      .get(norm) as unknown as PairingRow | undefined;
    if (row === undefined) return null;
    return this.approvePairing(row.id, agentId, opts);
  }

  /**
   * Approve a pending pairing: mark it approved and promote it to a binding for
   * the chosen agent. Returns the created binding, or null if the id is unknown.
   */
  approvePairing(id: number, agentId: string, opts: { label?: string; kind?: ChatKind } = {}): BoundChat | null {
    const pairing = this.getPairing(id);
    if (pairing === undefined) return null;
    const now = isoNow(this.clock);
    this.db
      .prepare("UPDATE channel_pairing_requests SET status = 'approved', resolved_at = ?, agent_id = ? WHERE id = ?")
      .run(now, agentId, id);
    return this.addBinding(agentId, pairing.provider, pairing.chat_id, opts);
  }

  /** Deny a pending pairing. Returns true when a pending row was updated. */
  denyPairing(id: number): boolean {
    const now = isoNow(this.clock);
    return (
      this.db
        .prepare("UPDATE channel_pairing_requests SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(now, id).changes > 0
    );
  }

  // --- invite links (FIX-channels-2) ---

  /** Persist a freshly-minted invite link (status active). */
  recordInvite(provider: string, chatId: string, link: string, opts: { name?: string; expiresAt?: string } = {}): ChannelInvite {
    const now = isoNow(this.clock);
    const info = this.db
      .prepare(`INSERT INTO channel_invites (provider, chat_id, link, name, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run(provider, chatId, link, opts.name ?? '', opts.expiresAt ?? null, now);
    const row = this.db.prepare('SELECT * FROM channel_invites WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as InviteRow;
    return this.toInvite(row);
  }

  /** Invite links for a provider, newest first, with the effective status. */
  listInvites(provider?: string): ChannelInvite[] {
    const rows = (
      provider === undefined
        ? this.db.prepare('SELECT * FROM channel_invites ORDER BY id DESC').all()
        : this.db.prepare('SELECT * FROM channel_invites WHERE provider = ? ORDER BY id DESC').all(provider)
    ) as unknown as InviteRow[];
    return rows.map((r) => this.toInvite(r));
  }

  getInvite(id: number): ChannelInvite | undefined {
    const row = this.db.prepare('SELECT * FROM channel_invites WHERE id = ?').get(id) as unknown as InviteRow | undefined;
    return row === undefined ? undefined : this.toInvite(row);
  }

  /** Mark an invite revoked (after the provider revoke succeeds). */
  revokeInvite(id: number): boolean {
    return this.db.prepare("UPDATE channel_invites SET status = 'revoked' WHERE id = ?").run(id).changes > 0;
  }

  private toInvite = (r: InviteRow): ChannelInvite => {
    let status: InviteStatus = r.status === 'revoked' ? 'revoked' : 'active';
    if (status === 'active' && r.expires_at !== null && Date.parse(r.expires_at) < this.clock.now().getTime()) status = 'expired';
    return { id: r.id, provider: r.provider, chatId: r.chat_id, link: r.link, name: r.name, status, expiresAt: r.expires_at, createdAt: r.created_at };
  };

  private toBound = (r: BindingRow): BoundChat => ({
    id: r.id,
    agentId: r.agent_id,
    provider: r.provider,
    chatId: r.chat_id,
    label: r.label,
    kind: r.kind === 'group' ? 'group' : 'dm',
    boundAt: r.bound_at,
  });
}
