// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { OutgoingEnvelope } from './smtpClient.js';
import { stripHeaderInjection } from './creds.js';
import { createLogger } from '../core/log.js';

const log = createLogger('email-outbox');

/**
 * Outbound email worker (#118 phase-3). Drains the pending outbound email replies the
 * CS agent logged (addInteraction direction='out', channel='email' -> send_status
 * 'pending') and sends each via SMTP, threaded to the original message. Durable +
 * retried: the reply is stored first (never lost); a failed send is retried next tick
 * and flips to 'failed' only after the attempt cap. The worker is constructed ONLY when
 * the email channel is enabled (dormant otherwise).
 */

/** The send surface the worker needs (the phase-1 SmtpClient satisfies it). */
export interface SmtpSender {
  send(env: OutgoingEnvelope): Promise<void>;
  quit(): Promise<void>;
}

export interface OutboxCsLike {
  listPendingOutbound(limit?: number): { id: number; customerId: string; ticketId: number; body: string }[];
  getCustomer(customerId: string): { email: string | null } | undefined;
  getTicket(customerId: string, ticketId: number): { subject: string } | undefined;
  threadParentMessageId(customerId: string, ticketId: number): string | undefined;
  markSent(interactionId: number, sentMessageId: string): void;
  markSendFailed(interactionId: number): void;
}

export interface OutboxDeps {
  cs: OutboxCsLike;
  fromAddress: string;
  /** Opens an AUTHENTICATED sender for one batch (the caller owns the TLS factory). */
  openSmtp: () => Promise<SmtpSender>;
  /** Generates a fresh `<id@domain>` Message-ID for our reply. */
  newMessageId: () => string;
  now: () => Date;
  batchSize?: number;
}

export class EmailOutbox {
  constructor(private readonly deps: OutboxDeps) {}

  /** Send one batch of pending outbound replies. Total — never throws. */
  async tick(): Promise<void> {
    const pending = this.deps.cs.listPendingOutbound(this.deps.batchSize ?? 20);
    if (pending.length === 0) return;
    let smtp: SmtpSender | undefined;
    try {
      smtp = await this.deps.openSmtp();
    } catch (err) {
      log.warn('outbox could not open SMTP; retrying next tick', { error: String(err) });
      return; // leave everything 'pending' for the next tick
    }
    try {
      for (const p of pending) {
        try {
          const to = this.deps.cs.getCustomer(p.customerId)?.email ?? '';
          if (to === '') {
            log.warn('outbound reply has no recipient address; marking failed', { interactionId: p.id });
            this.deps.cs.markSendFailed(p.id);
            continue;
          }
          const subject = this.deps.cs.getTicket(p.customerId, p.ticketId)?.subject ?? '';
          const inReplyTo = this.deps.cs.threadParentMessageId(p.customerId, p.ticketId);
          const messageId = this.deps.newMessageId();
          const data = composeReply({
            from: this.deps.fromAddress,
            to,
            subject,
            ticketId: p.ticketId,
            body: p.body,
            messageId,
            inReplyTo,
            date: this.deps.now(),
          });
          await smtp.send({ from: this.deps.fromAddress, to: [to], data });
          this.deps.cs.markSent(p.id, messageId);
        } catch (err) {
          log.warn('outbound email send failed; will retry', { interactionId: p.id, error: String(err) });
          this.deps.cs.markSendFailed(p.id);
        }
      }
    } finally {
      await smtp.quit().catch(() => undefined);
    }
  }
}

export interface ReplyParts {
  from: string;
  to: string;
  subject: string;
  ticketId: number;
  body: string;
  messageId: string;
  inReplyTo?: string | undefined;
  date: Date;
}

/** Build a threaded RFC822 reply. The (untrusted) subject is CR/LF-stripped to prevent header injection. */
export function composeReply(p: ReplyParts): string {
  const subject = formatSubject(p.subject, p.ticketId);
  const headers = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    `Subject: ${subject}`,
    `Message-ID: ${p.messageId}`,
    ...(p.inReplyTo !== undefined && p.inReplyTo !== ''
      ? [`In-Reply-To: ${p.inReplyTo}`, `References: ${p.inReplyTo}`]
      : []),
    `Date: ${p.date.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + p.body.replace(/\r?\n/g, '\r\n') + '\r\n';
}

/** "Re: <subject> [#ticketId]" — header-injection-safe, idempotent on Re:/token. */
function formatSubject(subject: string, ticketId: number): string {
  const clean = stripHeaderInjection(subject);
  const base = clean === '' ? '(no subject)' : clean;
  const withRe = /^re:/i.test(base) ? base : `Re: ${base}`;
  return /\[#\d+\]/.test(withRe) ? withRe : `${withRe} [#${ticketId}]`;
}
