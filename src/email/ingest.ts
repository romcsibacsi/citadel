// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { parseEmail } from './mime.js';
import { createLogger } from '../core/log.js';

const log = createLogger('email-ingest');

/**
 * Email ingestion (#118 phase-2): turn a raw inbound RFC822 message into the
 * customer-service store and notify the CS agent — WITHOUT ever putting the email
 * content where it could leak.
 *
 * (B)-isolation / PII invariant:
 *  - The email body + subject land ONLY in the customer_id-scoped cs_* store.
 *  - The CS agent is notified with a POINTER ONLY (ticket id + customer id); the
 *    body/subject NEVER go into the message body, agent memory, logs, or kanban.
 *    The agent reads the content through its scoped CS accessor.
 *  - The customer id is OPAQUE (newId), never derived from the email address.
 *  - Threading is customer-scoped, so a forged References header can never attach
 *    one end-customer's reply onto another's ticket.
 *  - Re-fetched messages dedupe by Message-ID (idempotent — safe to re-poll after
 *    a crash before the \Seen flag was set).
 */

/** The slice of CsStore the ingestor needs (structural, for decoupling + testing). */
export interface CsStoreLike {
  findCustomerByEmail(email: string): { id: string } | undefined;
  upsertCustomer(c: { id: string; email?: string; name?: string }): void;
  getTicket(customerId: string, ticketId: number): unknown | undefined;
  createTicket(customerId: string, t: { subject: string; assigneeAgent?: string }): number;
  addInteraction(
    customerId: string,
    ticketId: number,
    i: { direction: 'in' | 'out'; body: string; channel?: string; messageId?: string },
  ): number;
  findTicketByMessageId(customerId: string, messageId: string): number | undefined;
  hasMessageId(messageId: string): boolean;
}

/** A pollable mailbox (the phase-1 ImapClient satisfies this). */
export interface MailboxReader {
  searchUnseen(): Promise<number[]>;
  fetchBody(uid: number): Promise<Buffer>;
  markSeen(uid: number): Promise<void>;
}

export interface IngestDeps {
  cs: CsStoreLike;
  /** Enqueue the pointer notification to the CS agent. */
  enqueue: (msg: { sender: string; recipient: string; body: string }) => void;
  /** The CS ("support") agent id to notify + assign. */
  csAgentId: string;
  /** Opaque customer-id generator (never email-derived). */
  newId: () => string;
  /**
   * #386 FÁZIS-0: the inbound wake-sender CLASS (value 'cs-inbound') the support persona triggers
   * on (#269/#270). Injected (was a static import of CS_INBOUND_SENDER) so ingest.ts holds ZERO
   * knowledge of the cs/ vertical — main.ts feeds it from the registry's ingest hook.
   */
  csInboundSender: string;
}

export type IngestOutcome =
  | { status: 'ingested'; customerId: string; ticketId: number; interactionId: number }
  | { status: 'duplicate'; messageId: string };

export class EmailIngestor {
  constructor(private readonly deps: IngestDeps) {}

  /** Parse + ingest one raw message. Total (never throws on a malformed message). */
  ingestRaw(raw: Buffer): IngestOutcome {
    const email = parseEmail(raw);

    // 1) Dedup: a re-fetched message (same Message-ID) is a no-op.
    if (email.messageId !== '' && this.deps.cs.hasMessageId(email.messageId)) {
      return { status: 'duplicate', messageId: email.messageId };
    }

    // 2) Resolve the customer by sender address; create one with a fresh OPAQUE id.
    const address = email.fromAddress;
    const existing = address !== '' ? this.deps.cs.findCustomerByEmail(address) : undefined;
    const customerId = existing?.id ?? this.deps.newId();
    if (existing === undefined) {
      this.deps.cs.upsertCustomer({ id: customerId, email: address || undefined, name: email.fromName || undefined });
    }

    // 3) Thread: References/In-Reply-To (scoped) first, then a [#id] subject token,
    //    else open a new ticket.
    const ticketId = this.resolveTicket(customerId, email.inReplyTo, email.references, email.subject);

    // 4) Store the content in the scoped store (the system of record).
    const interactionId = this.deps.cs.addInteraction(customerId, ticketId, {
      direction: 'in',
      channel: 'email',
      body: email.text,
      ...(email.messageId !== '' ? { messageId: email.messageId } : {}),
    });

    // 5) POINTER-only notify — no subject/body crosses to the agent here. The sender is the shared
    //    CS_INBOUND_SENDER class (#270): a bespoke 'email-connector' sender delivered fine but the support
    //    persona never entered the reply flow, since it triggers on the cs-inbound class (like #269/widget).
    this.deps.enqueue({
      sender: this.deps.csInboundSender,
      recipient: this.deps.csAgentId,
      body:
        `New inbound email — ticket #${ticketId} for customer ${customerId}. ` +
        `Open it with your customer-service tool; the message content is in the scoped store.`,
    });

    return { status: 'ingested', customerId, ticketId, interactionId };
  }

  private resolveTicket(customerId: string, inReplyTo: string[], references: string[], subject: string): number {
    for (const mid of [...inReplyTo, ...references]) {
      const t = this.deps.cs.findTicketByMessageId(customerId, mid);
      if (t !== undefined) return t;
    }
    const token = /\[#(\d+)\]/.exec(subject);
    if (token) {
      const n = Number(token[1]);
      if (this.deps.cs.getTicket(customerId, n) !== undefined) return n;
    }
    return this.deps.cs.createTicket(customerId, {
      subject: subject.trim() === '' ? '(no subject)' : subject.trim(),
      assigneeAgent: this.deps.csAgentId,
    });
  }

  /**
   * Poll a mailbox once: fetch each UNSEEN message, ingest it, then mark it \Seen.
   * \Seen is set AFTER a durable ingest so a crash mid-poll re-delivers (and the
   * Message-ID dedup makes the re-delivery a no-op). A single message that fails to
   * ingest is logged and marked seen so it cannot poison the loop.
   */
  async pollOnce(mailbox: MailboxReader): Promise<IngestOutcome[]> {
    const uids = await mailbox.searchUnseen();
    const results: IngestOutcome[] = [];
    for (const uid of uids) {
      try {
        const raw = await mailbox.fetchBody(uid);
        results.push(this.ingestRaw(raw));
      } catch (err) {
        log.warn('email ingest failed; marking seen to avoid a poison loop', { uid, error: String(err) });
      }
      try {
        await mailbox.markSeen(uid);
      } catch (err) {
        log.warn('failed to mark message seen', { uid, error: String(err) });
      }
    }
    return results;
  }
}
