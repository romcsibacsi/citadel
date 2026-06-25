// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(component: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  // All logs go to stderr; stdout stays clean for CLI output.
  process.stderr.write(`${ts} [${level.toUpperCase()}] ${component}: ${msg}${extra}\n`);
}

export function createLogger(component: string): Logger {
  return {
    debug: (msg, fields) => emit(component, 'debug', msg, fields),
    info: (msg, fields) => emit(component, 'info', msg, fields),
    warn: (msg, fields) => emit(component, 'warn', msg, fields),
    error: (msg, fields) => emit(component, 'error', msg, fields),
  };
}
