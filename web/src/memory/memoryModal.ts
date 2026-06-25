// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { toast } from '../toast.js';
import { TIERS, TIER_EMOJI, type Memory, type RosterAgent, type Tier } from './model.js';

/**
 * Memory create/edit modal (PROMPT-08 §5A). Create posts a new memory; edit
 * PATCHes content/keywords/category (the backend pins the owning agent on edit,
 * so the Agent dropdown is informational in edit mode). Content is required.
 */
interface ModalOpts {
  memory?: Memory;
  roster: RosterAgent[];
  defaultTier?: Tier;
  onSaved: () => void;
}

export function openMemoryModal(opts: ModalOpts): void {
  const editing = opts.memory !== undefined;
  const m = opts.memory;

  const agentSel = h('select', null, ...opts.roster.map((a) => h('option', { value: a.id, selected: m?.agentId === a.id }, a.displayName))) as HTMLSelectElement;
  if (editing) agentSel.disabled = true;
  const tierSel = h('select', null, ...TIERS.map((tier) => h('option', { value: tier, selected: (m?.category ?? opts.defaultTier ?? 'warm') === tier }, `${TIER_EMOJI[tier]} ${t(`memory.tier.${tier}`)} (${t(`memory.tierHint.${tier}`)})`))) as HTMLSelectElement;
  const contentEl = h('textarea', { rows: 5, placeholder: t('memory.contentPlaceholder') }) as HTMLTextAreaElement;
  contentEl.value = m?.content ?? '';
  const keywordsEl = h('input', { type: 'text', placeholder: t('memory.keywordsPlaceholder'), value: m?.keywords ?? '' }) as HTMLInputElement;

  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => { backdrop.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const field = (labelKey: string, control: HTMLElement, hint?: HTMLElement): HTMLElement => h('div', { class: 'field' }, h('label', null, t(labelKey)), control, hint ?? null);

  const save = async (e: Event): Promise<void> => {
    if (contentEl.value.trim() === '') { contentEl.focus(); return; }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      if (editing && m) {
        await api.patch(`/api/memories/${m.id}`, { content: contentEl.value.trim(), keywords: keywordsEl.value.trim(), category: tierSel.value });
        toast(t('memory.updated'));
      } else {
        await api.post('/api/memories', { agentId: agentSel.value, category: tierSel.value, content: contentEl.value.trim(), keywords: keywordsEl.value.trim() });
        toast(t('memory.created'));
      }
      close();
      opts.onSaved();
    } catch (err) {
      // locale-robust: the server message is in the install locale (HU on the live host)
      const rejected = err instanceof ApiError && err.status === 400 && /rejected|security|filter|elutasít|biztonság|szűrő/i.test(err.message);
      toast(rejected ? t('memory.rejected') : t('memory.saveError'), true);
      btn.disabled = false;
    }
  };

  backdrop.append(
    h('div', { class: 'modal memory-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, editing ? t('memory.editTitle') : t('memory.newTitle')), h('button', { class: 'icon-btn', 'aria-label': t('memory.close'), onclick: close }, '✕')),
      h('div', { class: 'field-row' }, field('memory.agent', agentSel), field('memory.tier', tierSel)),
      field('memory.content', contentEl),
      field('memory.keywords', keywordsEl, h('div', { class: 'field-note' }, t('memory.keywordsHint'))),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: (e: Event) => void save(e) }, t('memory.save'))),
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  if (!editing) setTimeout(() => contentEl.focus(), 0);
}
