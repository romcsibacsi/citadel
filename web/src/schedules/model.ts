// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/** Shared Schedules DTOs (PROMPT-07). Field names match the backend store. */

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  target: string;
  type: 'task' | 'heartbeat';
  enabled: boolean;
  skipIfBusy: boolean;
  forceSend: boolean;
  bypassTriage: boolean;
  sessionTarget?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RetryRow {
  id: number;
  taskId: string;
  target: string;
  prompt: string;
  queuedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  alerted: boolean;
  status: string;
  lastReason?: string;
  alertDue?: boolean;
}

export interface RosterAgent { id: string; displayName: string; accentColor: string }
