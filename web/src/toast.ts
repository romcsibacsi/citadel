// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h } from './dom.js';

/**
 * Transient operator toasts (bottom-right). Shared across views/modals so the
 * markup + lifecycle stay consistent. `danger` styles it as an error.
 */
export function toast(message: string, danger = false): void {
  let host = document.querySelector<HTMLDivElement>('.toast-host');
  if (!host) {
    host = h('div', { class: 'toast-host' }) as HTMLDivElement;
    document.body.append(host);
  }
  const node = h('div', { class: `toast${danger ? ' err' : ''}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), 5000);
}
