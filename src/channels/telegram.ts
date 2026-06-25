// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { splitMessage } from './split.js';
import type { ChannelProvider, InboundEvent, InboundHandler, InboundMedia } from './provider.js';

/**
 * First-class owned reconnecting Telegram client (SPEC §7). Replaces the
 * entire flaky-plugin recovery layer with one long-poll loop:
 *
 *   getUpdates(offset) -> per update: dedup-claim -> await onInbound (durable
 *   handoff) -> ONLY after the whole batch is handed off, persist offset
 *   (last update_id + 1).
 *
 * Persisting the offset AFTER handoff makes delivery at-least-once: a crash
 * between handoff and offset write re-serves the batch, and the dedup table
 * (PRIMARY KEY (provider, update_id)) suppresses the duplicates.
 *
 * The bot token MUST NEVER appear in any log line or thrown error — every
 * error string passes through redact() which replaces the token with
 * '<redacted>'.
 */

const log = createLogger('channel.telegram');

const PROVIDER_ID = 'telegram';
const MAX_MESSAGE_LENGTH = 4096;
const LONG_POLL_TIMEOUT_S = 50;
/** Cap on consecutive 429 retries for a single chunk before giving up. */
const MAX_RATE_LIMIT_RETRIES = 10;

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
}

const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 1_000, maxMs: 30_000 };

/** Hard cap on a single inbound download (Telegram's bot download limit is 20MB). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const EXT_BY_KIND: Record<'photo' | 'document', string> = { photo: '.jpg', document: '.bin' };

/**
 * Make a safe on-disk filename from an UNTRUSTED provider-supplied name: keep
 * only the basename, allow just [A-Za-z0-9._-], drop leading dots (no hidden /
 * traversal), bound the length, and guarantee an extension. The result is later
 * prefixed with provider+message-id, so it can never escape the inbox dir.
 */
function safeFileName(raw: string, kind: 'photo' | 'document'): string {
  let cleaned = basename(raw).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (cleaned.length > 80) cleaned = cleaned.slice(-80);
  if (cleaned === '') cleaned = kind;
  if (extname(cleaned) === '') cleaned += EXT_BY_KIND[kind];
  return cleaned;
}

export interface TelegramChannelOptions {
  token: string;
  /** Open, migrated database — owns channel_offsets + channel_dedup rows. */
  db: DatabaseSync;
  onInbound: InboundHandler;
  /**
   * Directory for downloaded inbound media. When set, photo/document messages
   * are fetched and saved here (filenames are sanitized + id-prefixed). When
   * omitted, media is ignored and only text/caption is forwarded.
   */
  mediaDir?: string;
  /** Injectable HTTP transport (tests script fakes). Defaults to global fetch. */
  transport?: typeof fetch;
  clock?: Clock;
  backoff?: BackoffConfig;
  /** Injectable sleep so tests record delays instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1) for deterministic backoff tests. */
  random?: () => number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    chat?: { id: number | string };
    from?: { id?: number; username?: string; first_name?: string };
  };
}

interface TelegramApiPayload {
  ok?: boolean;
  description?: string;
  result?: unknown;
  parameters?: { retry_after?: number };
}

/** Internal: lets the poll loop distinguish the 409 conflict path. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class TelegramChannel implements ChannelProvider {
  readonly id = PROVIDER_ID;

  private readonly token: string;
  private readonly transport: typeof fetch;
  private readonly clock: Clock;
  private readonly backoff: BackoffConfig;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onInbound: InboundHandler;
  private readonly mediaDir?: string;

  private readonly claimStmt: StatementSync;
  private readonly unclaimStmt: StatementSync;
  private readonly getOffsetStmt: StatementSync;
  private readonly setOffsetStmt: StatementSync;

  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private abortCtl: AbortController | null = null;
  private stopRequested: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;

  constructor(opts: TelegramChannelOptions) {
    this.token = opts.token;
    this.transport = opts.transport ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.onInbound = opts.onInbound;
    this.mediaDir = opts.mediaDir;

    this.claimStmt = opts.db.prepare(
      'INSERT OR IGNORE INTO channel_dedup (provider, update_id, seen_at) VALUES (?, ?, ?)',
    );
    this.unclaimStmt = opts.db.prepare('DELETE FROM channel_dedup WHERE provider = ? AND update_id = ?');
    this.getOffsetStmt = opts.db.prepare('SELECT offset_value FROM channel_offsets WHERE provider = ?');
    this.setOffsetStmt = opts.db.prepare(
      `INSERT INTO channel_offsets (provider, offset_value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET offset_value = excluded.offset_value, updated_at = excluded.updated_at`,
    );
  }

  // ---------- lifecycle ----------

  /** Begin the long-poll loop. Idempotent; the loop never throws. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.loopDone = this.pollLoop();
    log.info('telegram polling started');
  }

  /** Stop polling; resolves once the loop has exited (aborts mid-poll cleanly). */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.resolveStop?.();
    this.abortCtl?.abort();
    await this.loopDone;
    log.info('telegram polling stopped');
  }

  // ---------- outbound ----------

  splitMessage(text: string): string[] {
    return splitMessage(text, MAX_MESSAGE_LENGTH);
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const chunk of this.splitMessage(text)) {
      await this.sendChunk(chatId, chunk);
    }
  }

  /** "… is typing" via sendChatAction (auto-expires ~5s). Best-effort; never throws. */
  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.transport(this.apiUrl('sendChatAction'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      });
    } catch {
      /* best-effort: a failed typing hint must never disrupt messaging */
    }
  }

  /** Upload a file via sendDocument (multipart). */
  async sendMedia(chatId: string, filePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption !== undefined) form.append('caption', caption);
    form.append('document', new Blob([new Uint8Array(readFileSync(filePath))]), basename(filePath));
    let res: Response;
    try {
      res = await this.transport(this.apiUrl('sendDocument'), { method: 'POST', body: form });
    } catch (err) {
      throw new Error(this.redact(`telegram sendDocument transport error: ${String(err)}`));
    }
    const payload = await this.readPayload(res);
    if (!res.ok || payload?.ok !== true) {
      throw new Error(
        this.redact(`telegram sendDocument failed: HTTP ${res.status} ${payload?.description ?? ''}`.trim()),
      );
    }
  }

  async validateToken(): Promise<boolean> {
    let res: Response;
    try {
      res = await this.transport(this.apiUrl('getMe'), { method: 'POST' });
    } catch (err) {
      log.warn('getMe transport error', { error: this.redact(String(err)) });
      return false;
    }
    if (!res.ok) return false;
    const payload = await this.readPayload(res);
    return payload?.ok === true;
  }

  /** Bot identity from getMe (@username + display name); null when unavailable. */
  async getIdentity(): Promise<{ username: string; name: string } | null> {
    let res: Response;
    try {
      res = await this.transport(this.apiUrl('getMe'), { method: 'POST' });
    } catch (err) {
      log.warn('getMe transport error', { error: this.redact(String(err)) });
      return null;
    }
    if (!res.ok) return null;
    const payload = await this.readPayload(res);
    if (payload?.ok !== true || typeof payload.result !== 'object' || payload.result === null) return null;
    const me = payload.result as { username?: string; first_name?: string };
    return { username: me.username ?? '', name: me.first_name ?? me.username ?? '' };
  }

  /**
   * Mint a chat invite link (Telegram createChatInviteLink), falling back to
   * exportChatInviteLink where the bot lacks per-link admin. Throws redacted on
   * failure — the caller surfaces it; the token never appears in the message.
   */
  async createInviteLink(chatId: string, opts: { expireSeconds?: number; memberLimit?: number } = {}): Promise<string> {
    const body: Record<string, unknown> = { chat_id: chatId };
    if (opts.expireSeconds !== undefined) body.expire_date = Math.floor(this.clock.now().getTime() / 1000) + opts.expireSeconds;
    if (opts.memberLimit !== undefined) body.member_limit = opts.memberLimit;
    for (const method of ['createChatInviteLink', 'exportChatInviteLink']) {
      let res: Response;
      try {
        res = await this.transport(this.apiUrl(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(method === 'createChatInviteLink' ? body : { chat_id: chatId }),
        });
      } catch (err) {
        throw new Error(this.redact(`telegram ${method} transport error: ${String(err)}`));
      }
      const payload = await this.readPayload(res);
      if (res.ok && payload?.ok === true) {
        const result = payload.result;
        const link = typeof result === 'string' ? result : (result as { invite_link?: string } | null)?.invite_link;
        if (typeof link === 'string' && link !== '') return link;
      }
      // try the fallback method only when the first one is unavailable
    }
    throw new Error('telegram invite link creation failed');
  }

  /** Revoke a previously-minted invite link (Telegram revokeChatInviteLink). */
  async revokeInviteLink(chatId: string, link: string): Promise<boolean> {
    let res: Response;
    try {
      res = await this.transport(this.apiUrl('revokeChatInviteLink'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, invite_link: link }),
      });
    } catch (err) {
      throw new Error(this.redact(`telegram revokeChatInviteLink transport error: ${String(err)}`));
    }
    const payload = await this.readPayload(res);
    return res.ok && payload?.ok === true;
  }

  /** True while the long-poll loop is active (the bot is "listening"). */
  isListening(): boolean {
    return this.running;
  }

  private async sendChunk(chatId: string, chunk: string): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await this.transport(this.apiUrl('sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        });
      } catch (err) {
        throw new Error(this.redact(`telegram sendMessage transport error: ${String(err)}`));
      }
      const payload = await this.readPayload(res);
      if (res.status === 429) {
        const headerRetry = Number(res.headers.get('retry-after'));
        const retryAfterS =
          payload?.parameters?.retry_after ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : 1);
        log.warn('telegram rate limited; honoring retry_after', { retryAfterS });
        await this.pause(retryAfterS * 1000);
        continue;
      }
      if (!res.ok || payload?.ok !== true) {
        throw new Error(
          this.redact(`telegram sendMessage failed: HTTP ${res.status} ${payload?.description ?? ''}`.trim()),
        );
      }
      return;
    }
    throw new Error('telegram sendMessage failed: rate-limit retries exhausted');
  }

  // ---------- inbound long-poll loop ----------

  private async pollLoop(): Promise<void> {
    let attempt = 0;
    let offset = this.loadOffset();
    while (this.running) {
      try {
        const updates = await this.fetchUpdates(offset);
        attempt = 0;
        if (updates.length === 0) continue;
        const next = await this.processBatch(updates);
        // Offset is persisted ONLY here, after the entire batch was handed off.
        this.persistOffset(next);
        offset = next;
      } catch (err) {
        if (!this.running) break;
        attempt += 1;
        const conflict = err instanceof HttpStatusError && err.status === 409;
        // Exponential backoff with jitter in [50%, 100%] of the capped delay;
        // a 409 conflict (another getUpdates consumer) jumps straight to maxMs.
        const cappedMs = conflict
          ? this.backoff.maxMs
          : Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (attempt - 1));
        const delayMs = this.jitter(cappedMs);
        const message = this.redact(err instanceof Error ? err.message : String(err));
        if (conflict) {
          log.error('telegram getUpdates conflict (409): another client is polling this token', {
            delayMs,
            error: message,
          });
        } else {
          log.warn('telegram poll failed; backing off', { attempt, delayMs, error: message });
        }
        await this.pause(delayMs);
      }
    }
  }

  private async fetchUpdates(offset: number | null): Promise<TelegramUpdate[]> {
    this.abortCtl = new AbortController();
    let res: Response;
    try {
      res = await this.transport(this.apiUrl('getUpdates'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(offset === null ? {} : { offset }), timeout: LONG_POLL_TIMEOUT_S }),
        signal: this.abortCtl.signal,
      });
    } catch (err) {
      throw new Error(this.redact(`telegram getUpdates transport error: ${String(err)}`));
    } finally {
      this.abortCtl = null;
    }
    const payload = await this.readPayload(res);
    if (!res.ok) {
      throw new HttpStatusError(
        res.status,
        this.redact(`telegram getUpdates failed: HTTP ${res.status} ${payload?.description ?? ''}`.trim()),
      );
    }
    if (payload?.ok !== true || !Array.isArray(payload.result)) {
      throw new Error(this.redact(`telegram getUpdates returned a non-ok payload: ${payload?.description ?? ''}`));
    }
    return payload.result.filter(
      (u): u is TelegramUpdate =>
        typeof u === 'object' && u !== null && typeof (u as TelegramUpdate).update_id === 'number',
    );
  }

  /**
   * Hand off one batch in arrival order. Every update is dedup-claimed first
   * (INSERT OR IGNORE; already-seen rows are skipped) and fresh text messages
   * are awaited through onInbound. A handoff rejection releases that claim
   * before propagating, so the re-served batch retries it (no message loss).
   * Returns the next offset (last update_id + 1) WITHOUT persisting it.
   */
  private async processBatch(updates: TelegramUpdate[]): Promise<number> {
    let maxUpdateId = Number.MIN_SAFE_INTEGER;
    for (const update of updates) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);
      const key = String(update.update_id);
      const fresh = Number(this.claimStmt.run(PROVIDER_ID, key, isoNow(this.clock)).changes) > 0;
      if (!fresh) {
        log.debug('duplicate update suppressed', { updateId: update.update_id });
        continue;
      }
      const event = await this.toEventAsync(update);
      if (event === undefined) continue; // nothing deliverable (service msg / unfetchable): claimed, advances offset
      try {
        await this.onInbound(event);
      } catch (err) {
        this.unclaimStmt.run(PROVIDER_ID, key);
        throw new Error(this.redact(`inbound handoff failed for update ${update.update_id}: ${String(err)}`));
      }
    }
    return maxUpdateId + 1;
  }

  /**
   * Normalize one update into an InboundEvent, downloading any photo/document
   * to the inbox dir first. Text comes from `text` or, for media, `caption`.
   * Returns undefined only when there is nothing to deliver (service message,
   * or media that could not be fetched and no text).
   */
  private async toEventAsync(update: TelegramUpdate): Promise<InboundEvent | undefined> {
    const m = update.message;
    if (m === undefined || m.chat?.id === undefined) return undefined;
    const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
    const media = await this.resolveMedia(m);
    if (text.length === 0 && media.length === 0) return undefined;
    const from = m.from ?? {};
    const user = from.username ?? from.first_name ?? (from.id === undefined ? '' : String(from.id));
    const ts = typeof m.date === 'number' ? new Date(m.date * 1000).toISOString() : isoNow(this.clock);
    const event: InboundEvent = {
      provider: PROVIDER_ID,
      chatId: String(m.chat.id),
      messageId: String(m.message_id),
      user,
      ts,
      text,
    };
    if (media.length > 0) event.media = media;
    return event;
  }

  /**
   * Download every attachment on a message into the inbox dir and return their
   * resolved local paths. Per-file failures are logged and skipped (never throw
   * into the poll loop — a permanently-unfetchable file must not wedge delivery).
   * No-op (returns []) when no mediaDir is configured.
   */
  private async resolveMedia(m: NonNullable<TelegramUpdate['message']>): Promise<InboundMedia[]> {
    if (this.mediaDir === undefined) return [];
    const descriptors: Array<{
      kind: 'photo' | 'document';
      fileId: string;
      fileName?: string;
      mimeType?: string;
      size?: number;
    }> = [];
    const largest = Array.isArray(m.photo) ? m.photo[m.photo.length - 1] : undefined; // Telegram lists sizes ascending
    if (largest !== undefined) {
      descriptors.push({ kind: 'photo', fileId: largest.file_id, size: largest.file_size });
    }
    if (m.document?.file_id !== undefined) {
      descriptors.push({
        kind: 'document',
        fileId: m.document.file_id,
        fileName: m.document.file_name,
        mimeType: m.document.mime_type,
        size: m.document.file_size,
      });
    }
    const out: InboundMedia[] = [];
    for (const d of descriptors) {
      try {
        const remotePath = await this.getFilePath(d.fileId);
        if (remotePath === undefined) continue;
        const bytes = await this.downloadFile(remotePath);
        const fileName = safeFileName(d.fileName ?? basename(remotePath), d.kind);
        mkdirSync(this.mediaDir, { recursive: true });
        const dest = join(this.mediaDir, `${PROVIDER_ID}-${String(m.message_id)}-${fileName}`);
        writeFileSync(dest, bytes, { mode: 0o600 });
        const item: InboundMedia = { kind: d.kind, path: dest, fileName };
        if (d.mimeType !== undefined) item.mimeType = d.mimeType;
        if (d.size !== undefined) item.size = d.size;
        out.push(item);
      } catch (err) {
        log.warn('telegram media download failed', {
          messageId: m.message_id,
          kind: d.kind,
          error: this.redact(String(err)),
        });
      }
    }
    return out;
  }

  /** Resolve a file_id to its temporary Telegram file_path (getFile). */
  private async getFilePath(fileId: string): Promise<string | undefined> {
    let res: Response;
    try {
      res = await this.transport(this.apiUrl('getFile'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
      });
    } catch (err) {
      throw new Error(this.redact(`telegram getFile transport error: ${String(err)}`));
    }
    const payload = await this.readPayload(res);
    if (!res.ok || payload?.ok !== true) {
      throw new Error(this.redact(`telegram getFile failed: HTTP ${res.status} ${payload?.description ?? ''}`.trim()));
    }
    const result = payload.result as { file_path?: string } | null;
    return typeof result?.file_path === 'string' && result.file_path !== '' ? result.file_path : undefined;
  }

  /** Download the bytes for a resolved file_path (size-capped). */
  private async downloadFile(remotePath: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.transport(this.fileUrl(remotePath), { method: 'GET' });
    } catch (err) {
      throw new Error(this.redact(`telegram file download transport error: ${String(err)}`));
    }
    if (!res.ok) throw new Error(this.redact(`telegram file download failed: HTTP ${res.status}`));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) throw new Error(`telegram file too large: ${buf.length} bytes`);
    return buf;
  }

  /** The file-download base is distinct from the bot-API base (token still secret). */
  private fileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.token}/${filePath}`;
  }

  // ---------- persistence ----------

  private loadOffset(): number | null {
    const row = this.getOffsetStmt.get(PROVIDER_ID) as { offset_value: string } | undefined;
    if (row === undefined) return null;
    const n = Number(row.offset_value);
    return Number.isFinite(n) ? n : null;
  }

  private persistOffset(next: number): void {
    this.setOffsetStmt.run(PROVIDER_ID, String(next), isoNow(this.clock));
  }

  // ---------- helpers ----------

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  /** Every error/log string passes through here; the token never escapes. */
  private redact(s: string): string {
    return s.split(this.token).join('<redacted>');
  }

  private async readPayload(res: Response): Promise<TelegramApiPayload | undefined> {
    try {
      const parsed: unknown = await res.json();
      return typeof parsed === 'object' && parsed !== null ? (parsed as TelegramApiPayload) : undefined;
    } catch {
      return undefined;
    }
  }

  private jitter(ms: number): number {
    return Math.max(1, Math.floor(ms * (0.5 + 0.5 * this.random())));
  }

  /** Sleep that wakes early on stop() so shutdown never waits out a backoff. */
  private async pause(ms: number): Promise<void> {
    if (this.running && this.stopRequested !== null) {
      await Promise.race([this.sleepFn(ms), this.stopRequested]);
      return;
    }
    await this.sleepFn(ms);
  }
}
