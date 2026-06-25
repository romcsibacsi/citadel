// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h } from './dom.js';
import { t } from './i18n.js';
import { framedAvatar } from './framedAvatar.js';
import { ACCENTS } from './theme.js';

/**
 * Avatar picker (PROMPT-03 §3): a gallery of preset avatars + an upload zone.
 * On a subscription-only host with no image-upload backend, the "presets" are
 * the design-system accent palette — picking one re-tints the agent's monogram
 * disc (persisted as the agent's accent color). The upload zone is surfaced for
 * parity but reports that image upload is configured on the host (deferred).
 */
export function avatarPicker(displayName: string, currentAccent: string, onPick: (accent: string) => void): HTMLElement {
  const gallery = h(
    'div',
    { class: 'avatar-gallery' },
    ...ACCENTS.map((accent) =>
      h(
        'button',
        {
          class: `avatar-choice${accent.toLowerCase() === currentAccent.toLowerCase() ? ' active' : ''}`,
          'aria-label': accent,
          type: 'button',
          onclick: () => onPick(accent),
        },
        framedAvatar(displayName || '?', accent, 48),
      ),
    ),
  );
  const drop = h(
    'div',
    { class: 'file-dropzone disabled', 'aria-disabled': 'true' },
    h('div', { class: 'dz-title' }, t('agents.avatar.upload')),
    h('div', { class: 'dz-note' }, t('agents.avatar.uploadDeferred')),
  );
  return h(
    'div',
    { class: 'avatar-picker' },
    h('div', { class: 'avatar-gallery-head' }, t('agents.avatar.choose')),
    gallery,
    h('div', { class: 'or-divider' }, t('agents.or')),
    drop,
  );
}
