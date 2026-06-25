// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from './dom.js';
import { t } from './i18n.js';
import { api, ApiError } from './api.js';
import { toast } from './toast.js';
import { collectDrop, type DroppedFile } from './skillDrop.js';

/**
 * Skill editor modal (PROMPT-03 §3/§5C): two tabs — Create (generate a local
 * skill doc from a free-form brief) and Import (pull a skill folder from a host
 * path; the backend validates against traversal/symlinks). Skills are created in
 * the agent's local scope.
 */
export function openSkillEditor(agentId: string, onChanged: () => void): void {
  let tab: 'create' | 'import' = 'create';

  const nameEl = h('input', { type: 'text', placeholder: t('skillEditor.namePlaceholder') }) as HTMLInputElement;
  const descEl = h('textarea', { rows: 5, placeholder: t('skillEditor.descPlaceholder') }) as HTMLTextAreaElement;
  const srcEl = h('input', { type: 'text', placeholder: '/path/to/skill-folder' }) as HTMLInputElement;

  const body = h('div', { class: 'skilled-body' });
  const tabs = h('div', { class: 'agent-modal-tabs' });

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

  const field = (labelKey: string, control: HTMLElement): HTMLElement =>
    h('div', { class: 'field' }, h('label', null, t(labelKey)), control);

  const generate = async (e: Event): Promise<void> => {
    const name = nameEl.value.trim();
    if (name === '' || descEl.value.trim() === '') {
      (name === '' ? nameEl : descEl).focus();
      return;
    }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('skillEditor.generating');
    const docBody = `# ${name}\n\n${descEl.value.trim()}\n`;
    try {
      await api.post('/api/skills', { scope: 'local', agentId, name, description: descEl.value.trim().split('\n')[0]!.slice(0, 120), body: docBody });
      close();
      toast(t('skillEditor.created', { name }));
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
      btn.disabled = false;
      btn.textContent = t('skillEditor.generate');
    }
  };

  const doImport = async (e: Event): Promise<void> => {
    if (srcEl.value.trim() === '') {
      srcEl.focus();
      return;
    }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('skillEditor.importing');
    try {
      await api.post('/api/skills/import', { scope: 'local', agentId, sourceDir: srcEl.value.trim() });
      close();
      toast(t('skillEditor.imported'));
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
      btn.disabled = false;
      btn.textContent = t('skillEditor.import');
    }
  };

  // drag/drop a skill folder or files (FIX-03 §6): read them client-side and POST
  // as {rel, content}; the backend writes them to a temp dir + reuses the hardened
  // importSkillDir. Binary .zip/.tar.gz archives are deferred (no zero-dep parser).
  const onDrop = async (e: DragEvent): Promise<void> => {
    if (e.dataTransfer === null) return;
    let files: DroppedFile[];
    try {
      files = await collectDrop(e.dataTransfer);
    } catch {
      toast(t('skillEditor.importEmpty'), true);
      return;
    }
    if (files.length === 0) { toast(t('skillEditor.importEmpty'), true); return; }
    try {
      await api.post('/api/skills/import-files', { scope: 'local', agentId, files });
      close();
      toast(t('skillEditor.imported'));
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
    }
  };

  const footer = h('div', { class: 'modal-actions' });

  const renderTabs = (): void => {
    mount(
      tabs,
      h('button', { class: `tab${tab === 'create' ? ' active' : ''}`, onclick: () => { tab = 'create'; render(); } }, t('skillEditor.tab.create')),
      h('button', { class: `tab${tab === 'import' ? ' active' : ''}`, onclick: () => { tab = 'import'; render(); } }, t('skillEditor.tab.import')),
    );
  };

  const render = (): void => {
    renderTabs();
    if (tab === 'create') {
      mount(body, field('skillEditor.name', nameEl), field('skillEditor.desc', descEl));
      mount(footer, h('button', { class: 'primary', onclick: (e: Event) => void generate(e) }, t('skillEditor.generate')));
    } else {
      const dz = h('div', { class: 'file-dropzone' }, h('div', { class: 'dz-title' }, t('skillEditor.importDrop')), h('div', { class: 'dz-note' }, t('skillEditor.importNote')));
      dz.addEventListener('dragover', (e: Event) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e: DragEvent) => { e.preventDefault(); dz.classList.remove('drag'); void onDrop(e); });
      mount(body, dz, field('skillEditor.sourceDir', srcEl));
      mount(footer, h('button', { class: 'primary', onclick: (e: Event) => void doImport(e) }, t('skillEditor.import')));
    }
  };

  backdrop.append(
    h(
      'div',
      { class: 'modal skilled-modal' },
      h(
        'div',
        { class: 'agent-modal-titlebar' },
        h('h2', null, t('skillEditor.title')),
        h('button', { class: 'icon-btn', 'aria-label': t('agents.close'), onclick: close }, '✕'),
      ),
      tabs,
      body,
      footer,
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  render();
  nameEl.focus();
}
