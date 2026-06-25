// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h } from './dom.js';

/**
 * The signature framed avatar: a glyph (agent initials) on a tinted dark radial
 * disc, circular-cropped, with a 2px --ac rim + inset shadow and an outer accent
 * glow that scales with --glow. Theme flourishes (obsidian rune sweep, stark
 * reticle) are pure CSS keyed on data-theme; reduced-motion disables the sweep.
 */
export function framedAvatar(displayName: string, accent: string, size = 64): HTMLElement {
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .slice(0, 2) || displayName.slice(0, 2).toUpperCase();
  return h(
    'div',
    { class: 'avatar', style: `--ac: ${accent}; --size: ${size}px` },
    h('div', { class: 'sweep' }),
    h('div', { class: 'disc' }, initials),
  );
}
