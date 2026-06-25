// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { toast } from '../toast.js';
import { FREQUENCIES, formToCron, cronToForm, type FreqValue } from './cron.js';
import type { RosterAgent, ScheduledTask } from './model.js';

/**
 * Create / Edit schedule modal (PROMPT-07 §5.1). One modal both modes; Name is
 * the immutable id (disabled in edit). Heartbeat templates prefill description +
 * prompt + a custom cadence. The "Smart expand" wizard is deterministic + client-
 * side (no LLM call, honoring the subscription-only invariant): it asks fixed
 * multiple-choice clarifiers and composes a structured, detailed prompt from the
 * answers.
 */

interface ModalOpts {
  schedule?: ScheduledTask;
  roster: RosterAgent[];
  onSaved: () => void;
}

const HEARTBEAT_TEMPLATES = ['custom', 'calendar', 'email', 'kanban', 'full'] as const;
type TemplateId = (typeof HEARTBEAT_TEMPLATES)[number];
const TEMPLATE_CRON: Record<Exclude<TemplateId, 'custom'>, string> = {
  calendar: '*/15 * * * *',
  email: '*/30 * * * *',
  kanban: '0 */2 * * *',
  full: '*/15 * * * *',
};

const EXPAND_QUESTIONS = [
  { q: 'schedules.expand.q1', opts: ['schedules.expand.q1a', 'schedules.expand.q1b'] },
  { q: 'schedules.expand.q2', opts: ['schedules.expand.q2a', 'schedules.expand.q2b', 'schedules.expand.q2c'] },
  { q: 'schedules.expand.q3', opts: ['schedules.expand.q3a', 'schedules.expand.q3b'] },
];

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export function openScheduleModal(opts: ModalOpts): void {
  const editing = opts.schedule !== undefined;
  const s = opts.schedule;
  const init = s ? cronToForm(s.cron) : { freq: 'daily' as FreqValue, time: '09:00', customCron: '' };

  // --- fields ---
  const nameEl = h('input', { type: 'text', placeholder: t('schedules.namePlaceholder'), value: s?.id ?? '', ...(editing ? { disabled: true } : {}) }) as HTMLInputElement;
  const agentSel = h('select', null,
    h('option', { value: 'all', selected: s?.target === 'all' }, t('schedules.broadcast')),
    ...opts.roster.map((a) => h('option', { value: a.id, selected: s?.target === a.id }, a.displayName)),
  ) as HTMLSelectElement;
  const typeSel = h('select', null,
    h('option', { value: 'task', selected: (s?.type ?? 'task') === 'task' }, t('schedules.type.task')),
    h('option', { value: 'heartbeat', selected: s?.type === 'heartbeat' }, t('schedules.type.heartbeat')),
  ) as HTMLSelectElement;
  const templateSel = h('select', null, ...HEARTBEAT_TEMPLATES.map((tpl) => h('option', { value: tpl }, t(`schedules.template.${tpl}`)))) as HTMLSelectElement;
  const descEl = h('input', { type: 'text', placeholder: t('schedules.descPlaceholder'), value: s?.title ?? '' }) as HTMLInputElement;
  const promptEl = h('textarea', { rows: 6, placeholder: t('schedules.promptPlaceholder') }) as HTMLTextAreaElement;
  promptEl.value = s?.prompt ?? '';
  const freqSel = h('select', null, ...FREQUENCIES.map((f) => h('option', { value: f.value, selected: init.freq === f.value }, t(f.labelKey)))) as HTMLSelectElement;
  const timeEl = h('input', { type: 'time', value: init.time }) as HTMLInputElement;
  const customCronEl = h('input', { type: 'text', placeholder: '0 12 * * *', value: init.customCron }) as HTMLInputElement;
  const skipBusyEl = h('input', { type: 'checkbox' }) as HTMLInputElement; skipBusyEl.checked = s?.skipIfBusy ?? false;
  const alwaysEl = h('input', { type: 'checkbox' }) as HTMLInputElement; alwaysEl.checked = s?.forceSend ?? false;
  const bypassEl = h('input', { type: 'checkbox' }) as HTMLInputElement; bypassEl.checked = s?.bypassTriage ?? false;
  const sessionEl = h('input', { type: 'text', placeholder: t('schedules.sessionPlaceholder'), value: s?.sessionTarget ?? '' }) as HTMLInputElement;

  // --- expand wizard ---
  const expandStatus = h('div', { class: 'field-note expand-status' });
  const questionsBlock = h('div', { class: 'expand-questions', style: 'display:none' });
  const answers: Record<number, string> = {};

  const renderQuestions = (): void => {
    questionsBlock.style.display = '';
    mount(questionsBlock,
      ...EXPAND_QUESTIONS.map((qq, qi) =>
        h('div', { class: 'expand-q' },
          h('div', { class: 'expand-q-text' }, t(qq.q)),
          h('div', { class: 'expand-opts' }, ...qq.opts.map((o) => {
            const btn = h('button', { type: 'button', class: 'expand-opt', onclick: () => {
              answers[qi] = t(o);
              for (const sib of (btn.parentElement?.children ?? [])) sib.classList.remove('active');
              btn.classList.add('active');
            } }, t(o));
            return btn;
          })),
        ),
      ),
      h('button', { type: 'button', class: 'primary compact', onclick: () => doExpand() }, t('schedules.expand.expandBtn')),
    );
  };

  const smartExpand = h('button', { type: 'button', class: 'expand-btn', onclick: () => {
    if (promptEl.value.trim() === '') { promptEl.focus(); return; }
    expandStatus.textContent = t('schedules.expand.generating');
    setTimeout(() => { expandStatus.textContent = ''; renderQuestions(); }, 250);
  } }, t('schedules.expand.smart'));

  const doExpand = (): void => {
    if (Object.keys(answers).length === 0) { toast(t('schedules.expand.needAnswer'), true); return; }
    const lines = EXPAND_QUESTIONS.map((qq, qi) => (answers[qi] ? `- ${t(qq.q)} ${answers[qi]}` : null)).filter(Boolean);
    promptEl.value = `${promptEl.value.trim()}\n\n${t('schedules.expand.detailsHeader')}\n${lines.join('\n')}`;
    questionsBlock.style.display = 'none';
    toast(t('schedules.expand.success'));
  };

  // --- conditional visibility ---
  const templateRow = h('div', { class: 'field', style: 'display:none' }, h('label', null, t('schedules.template')), templateSel);
  const timeField = h('div', { class: 'field' }, h('label', null, t('schedules.time')), timeEl);
  const customField = h('div', { class: 'field', style: 'display:none' }, h('label', null, t('schedules.cron')), customCronEl, h('div', { class: 'field-note' }, t('schedules.cronHint')));
  const bypassRow = h('label', { class: 'inline-check', style: 'display:none' }, bypassEl, t('schedules.flag.bypassTriage'));

  const syncType = (): void => {
    const isHb = typeSel.value === 'heartbeat';
    templateRow.style.display = isHb ? '' : 'none';
    bypassRow.style.display = isHb ? '' : 'none';
    if (isHb && promptEl.value.trim() === '') { freqSel.value = 'custom'; customCronEl.value = '*/15 * * * *'; syncFreq(); }
  };
  const syncFreq = (): void => {
    const preset = FREQUENCIES.find((f) => f.value === freqSel.value);
    timeField.style.display = preset?.showsTime ? '' : 'none';
    customField.style.display = freqSel.value === 'custom' ? '' : 'none';
    if (freqSel.value === 'custom') customCronEl.focus();
  };
  typeSel.addEventListener('change', syncType);
  freqSel.addEventListener('change', syncFreq);
  templateSel.addEventListener('change', () => {
    const tpl = templateSel.value as TemplateId;
    if (tpl === 'custom') return;
    descEl.value = t(`schedules.template.${tpl}`);
    promptEl.value = t(`schedules.templatePrompt.${tpl}`);
    freqSel.value = 'custom';
    customCronEl.value = TEMPLATE_CRON[tpl];
    syncFreq();
  });

  // --- modal shell ---
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => { backdrop.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const field = (labelKey: string, control: HTMLElement): HTMLElement => h('div', { class: 'field' }, h('label', null, t(labelKey)), control);

  const save = async (e: Event): Promise<void> => {
    const id = editing ? s!.id : slugify(nameEl.value);
    if (id === '') { nameEl.focus(); return; }
    if (promptEl.value.trim() === '') { promptEl.focus(); return; }
    const cron = formToCron(freqSel.value as FreqValue, timeEl.value, customCronEl.value);
    if (cron.trim() === '') { toast(t('schedules.chooseSchedule'), true); return; }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('schedules.saving');
    const payload = {
      title: descEl.value.trim() || id,
      prompt: promptEl.value.trim(),
      cron,
      target: agentSel.value,
      type: typeSel.value,
      skipIfBusy: skipBusyEl.checked,
      forceSend: alwaysEl.checked,
      bypassTriage: bypassEl.checked,
      ...(sessionEl.value.trim() ? { sessionTarget: sessionEl.value.trim() } : {}),
    };
    try {
      if (editing) await api.patch(`/api/schedules/${encodeURIComponent(id)}`, payload);
      else await api.post('/api/schedules', { id, ...payload });
      toast(editing ? t('schedules.updated') : t('schedules.created'));
      close();
      opts.onSaved();
    } catch (err) {
      toast(t('schedules.errorPrefix', { message: err instanceof ApiError ? err.message : String(err) }), true);
      btn.disabled = false;
      btn.textContent = t('schedules.save');
    }
  };

  backdrop.append(
    h('div', { class: 'modal schedule-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, editing ? t('schedules.editTitle') : t('schedules.createTitle')), h('button', { class: 'icon-btn', 'aria-label': t('schedules.close'), onclick: close }, '✕')),
      h('div', { class: 'wizard-body' },
        h('div', { class: 'field-row' }, field('schedules.name', nameEl), field('schedules.agent', agentSel)),
        h('div', { class: 'field-row' }, field('schedules.type', typeSel), templateRow),
        field('schedules.descLabel', descEl),
        field('schedules.prompt', promptEl),
        h('div', { class: 'expand-row' }, smartExpand, expandStatus),
        questionsBlock,
        h('div', { class: 'field-row' }, field('schedules.frequency', freqSel), timeField),
        customField,
        h('div', { class: 'settings-section' },
          h('div', { class: 'sec-title' }, t('schedules.advanced')),
          h('label', { class: 'inline-check' }, skipBusyEl, t('schedules.flag.skipIfBusy')),
          h('label', { class: 'inline-check' }, alwaysEl, t('schedules.flag.alwaysSend')),
          bypassRow,
          field('schedules.sessionLabel', sessionEl),
        ),
      ),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: (e: Event) => void save(e) }, t('schedules.save'))),
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  syncType();
  syncFreq();
  if (!editing) nameEl.focus();
}
