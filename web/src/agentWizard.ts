// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from './dom.js';
import { t } from './i18n.js';
import { api, ApiError } from './api.js';
import { toast } from './toast.js';
import { avatarPicker } from './avatarPicker.js';
import {
  fetchModels,
  fetchProfiles,
  buildModelSelect,
  buildProfileSelect,
  profileDescription,
  type ModelsDto,
  type ProfileEntry,
} from './catalogs.js';

/**
 * Creation wizard (PROMPT-03 §3/§5A): a three-step modal — identity → generation
 * → review/edit of the generated CLAUDE.md / SOUL.md. "Next" creates + scaffolds
 * the agent and generates its identity docs server-side; "Create" saves the
 * (possibly edited) docs and finishes. On success it opens the new agent's detail
 * on the Channel tab so the operator can wire its channel next.
 */
export function openAgentWizard(onCreated: (newId: string, openChannel: boolean) => void): void {
  let step = 1;
  let accent = '#9b79ff';
  let createdId = '';
  let models: ModelsDto | null = null;
  let profiles: ProfileEntry[] = [];

  const nameEl = h('input', { type: 'text', placeholder: t('agents.wizard.namePlaceholder') }) as HTMLInputElement;
  const descEl = h('textarea', { rows: 4, placeholder: t('agents.wizard.descPlaceholder') }) as HTMLTextAreaElement;
  const modelHolder = h('div');
  const profileHolder = h('div');
  const profileDesc = h('div', { class: 'field-note' });
  const personaEl = h('textarea', { class: 'mono', rows: 10 }) as HTMLTextAreaElement;
  const operatingEl = h('textarea', { class: 'mono', rows: 12 }) as HTMLTextAreaElement;
  const genStatus = h('div', { class: 'gen-status' }, t('agents.wizard.gen.start'));

  const body = h('div', { class: 'wizard-body' });
  const pips = h('div', { class: 'stepper' });
  const footer = h('div', { class: 'modal-actions' });

  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('modal-open');
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const renderPips = (): void => {
    mount(
      pips,
      ...[1, 2, 3].map((n) => h('span', { class: `pip${n === step ? ' active' : ''}${n < step ? ' done' : ''}` })),
    );
  };

  const field = (labelKey: string, control: HTMLElement, note?: HTMLElement): HTMLElement =>
    h('div', { class: 'field' }, h('label', null, t(labelKey)), control, note ?? null);

  const refreshProfileDesc = (): void => {
    const sel = profileHolder.querySelector('select');
    profileDesc.textContent = sel ? profileDescription(profiles, sel.value) : '';
  };

  const renderStep1 = (): void => {
    if (models) mount(modelHolder, buildModelSelect(models, 'inherit'));
    // only creatable profiles (the spawn ceiling forbids level > 2 via the API)
    const creatable = profiles.filter((p) => p.privilegeLevel <= 2);
    if (creatable.length) {
      const sel = buildProfileSelect(creatable, creatable.find((p) => p.id === 'sandbox') ? 'sandbox' : creatable[0]!.id);
      sel.addEventListener('change', refreshProfileDesc);
      mount(profileHolder, sel);
      refreshProfileDesc();
    }
    mount(
      body,
      avatarPicker(nameEl.value || '?', accent, (a) => {
        accent = a;
        renderStep1();
      }),
      field('agents.wizard.name', nameEl),
      field('agents.wizard.desc', descEl),
      field('agents.field.model', modelHolder),
      field('agents.field.profile', profileHolder, profileDesc),
    );
    mount(footer, h('button', { class: 'primary', onclick: () => void next() }, t('agents.wizard.next')));
  };

  const renderStep2 = (): void => {
    mount(body, h('div', { class: 'wizard-gen' }, h('div', { class: 'spinner-lg' }), genStatus, h('div', { class: 'field-note' }, t('agents.wizard.gen.hint'))));
    mount(footer);
  };

  const renderStep3 = (): void => {
    mount(
      body,
      field('agents.wizard.persona', personaEl),
      field('agents.wizard.operating', operatingEl),
    );
    mount(
      footer,
      h('button', { onclick: () => { step = 1; render(); } }, t('agents.wizard.back')),
      h('button', { class: 'primary', 'data-create': '1', onclick: (e: Event) => void create(e) }, t('agents.wizard.create')),
    );
  };

  const render = (): void => {
    renderPips();
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else renderStep3();
  };

  const next = async (): Promise<void> => {
    if (nameEl.value.trim() === '') {
      nameEl.focus();
      return;
    }
    if (descEl.value.trim() === '') {
      descEl.focus();
      return;
    }
    step = 2;
    render();
    try {
      const modelSel = modelHolder.querySelector('select');
      const profileSel = profileHolder.querySelector('select');
      const model = modelSel && modelSel.value !== 'inherit' ? modelSel.value : undefined;
      const role = descEl.value.trim().split('\n')[0]!.slice(0, 60);

      genStatus.textContent = t('agents.wizard.gen.creating');
      const created = await api.post<{ created: string }>('/api/agents', {
        id: nameEl.value.trim(),
        displayName: nameEl.value.trim(),
        role,
        securityProfile: profileSel?.value ?? 'sandbox',
        accentColor: accent,
        ...(model ? { model } : {}),
      });
      createdId = created.created;

      genStatus.textContent = t('agents.wizard.gen.docs');
      await api.post(`/api/agents/${encodeURIComponent(createdId)}/generate`, { description: descEl.value.trim() });

      genStatus.textContent = t('agents.wizard.gen.loading');
      const docs = await api.get<{ persona: string; operating: string }>(`/api/agents/${encodeURIComponent(createdId)}/docs`);
      personaEl.value = docs.persona;
      operatingEl.value = docs.operating;

      genStatus.textContent = t('agents.wizard.gen.done');
      step = 3;
      render();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
      step = 1;
      render();
    }
  };

  const create = async (e: Event): Promise<void> => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('agents.wizard.creating');
    try {
      await api.put(`/api/agents/${encodeURIComponent(createdId)}/docs`, {
        persona: personaEl.value,
        operating: operatingEl.value,
      });
      close();
      toast(t('agents.wizard.created'));
      onCreated(createdId, true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
      btn.disabled = false;
      btn.textContent = t('agents.wizard.create');
    }
  };

  backdrop.append(
    h(
      'div',
      { class: 'modal wizard-modal' },
      h(
        'div',
        { class: 'agent-modal-titlebar' },
        h('h2', null, t('agents.wizard.title')),
        h('button', { class: 'icon-btn', 'aria-label': t('agents.close'), onclick: close }, '✕'),
      ),
      pips,
      body,
      footer,
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');

  // load catalogs, then paint step 1
  Promise.all([fetchModels(), fetchProfiles()])
    .then(([m, p]) => {
      models = m;
      profiles = p;
      render();
      nameEl.focus();
    })
    .catch(() => {
      render();
    });
  render();
}
