// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Channels view (FIX-channels). The channel-management surface now lives in the
 * shared component, mounted here in install scope. This view is no longer a nav
 * item (folded into Settings → Channels per the spec) but stays registered so an
 * existing #channels deep-link still resolves to the same panel.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { mountChannelPanel } from '../components/channelPanel.js';

defineView('channels', 'nav.channels', (host) => {
  const panel = h('div', { class: 'channel-page' });
  mount(
    host,
    h('div', { class: 'page-header' }, h('h1', null, t('channels.title')), h('p', { class: 'subtitle' }, t('channels.subtitle'))),
    panel,
  );
  mountChannelPanel(panel, { scope: 'install' });
});
