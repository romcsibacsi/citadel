// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Schedules (Ütemezések) view (PROMPT-07): create/edit/pause/delete recurring AI
 * tasks on a cron timetable. Three view modes (List / Daily timeline / Week), a
 * conditional pending-retry banner, and the rich create/edit modal. Reloads on
 * mutation; the pending queue + timeline "now" line refresh on a gentle poll.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { framedAvatar } from '../framedAvatar.js';
import { openScheduleModal } from '../schedules/scheduleModal.js';
import { humanCron, cronHours, cronMinute, cronWeekdaysMonFirst } from '../schedules/cron.js';
import type { RetryRow, RosterAgent, ScheduledTask } from '../schedules/model.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type ViewMode = 'list' | 'timeline' | 'week';
let viewMode: ViewMode = 'list'; // persists across the shell's re-renders

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  let roster: RosterAgent[] = [];
  let schedules: ScheduledTask[] = [];
  let retries: RetryRow[] = [];

  const accentOf = (id: string): string => roster.find((a) => a.id === id)?.accentColor ?? 'var(--accent)';
  const labelOf = (id: string): string => (id === 'all' ? t('schedules.broadcast') : roster.find((a) => a.id === id)?.displayName ?? id);

  const banner = h('div', { class: 'retry-banner', style: 'display:none' });
  const viewBox = h('div', { class: 'schedules-view' });
  const reload = (): void => void load();

  // ---------------------------------------------------------------- list view
  const scheduleRow = (s: ScheduledTask): HTMLElement => {
    const badges = h('span', { class: 'row-badges' },
      s.type === 'heartbeat' ? h('span', { class: 'badge hb-badge' }, t('schedules.heartbeatBadge')) : null,
      h('span', { class: `badge ${s.enabled ? 'on' : 'muted'}` }, s.enabled ? t('schedules.statusActive') : t('schedules.statusPaused')),
    );
    const toggle = h('button', { class: 'icon-btn', title: s.enabled ? t('schedules.pause') : t('schedules.resume'), onclick: (e: Event) => { e.stopPropagation(); void toggleSchedule(s); } }, icon(s.enabled ? 'pause' : 'play', 16));
    const del = h('button', { class: 'icon-btn danger', title: t('schedules.delete'), onclick: (e: Event) => { e.stopPropagation(); void deleteSchedule(s); } }, icon('trash', 16));
    return h('div', { class: `schedule-row${s.enabled ? '' : ' disabled'}`, role: 'button', onclick: () => openScheduleModal({ schedule: s, roster, onSaved: reload }) },
      framedAvatar(labelOf(s.target), accentOf(s.target), 40),
      h('div', { class: 'sched-info' },
        h('div', { class: 'sched-title' }, s.title || s.id, badges),
        h('div', { class: 'sched-meta' }, h('span', { class: 'mono' }, s.cron), h('span', null, humanCron(s.cron)), h('span', null, labelOf(s.target))),
      ),
      h('div', { class: 'sched-actions' }, toggle, del),
    );
  };

  const renderList = (): void => {
    if (schedules.length === 0) { mount(viewBox, h('div', { class: 'empty-block' }, icon('schedules', 40), h('div', { class: 'muted-note' }, t('schedules.empty')))); return; }
    mount(viewBox, h('div', { class: 'schedule-list' }, ...schedules.map(scheduleRow)));
  };

  // ---------------------------------------------------------------- daily timeline
  const renderTimeline = (): void => {
    if (schedules.length === 0) { mount(viewBox, h('div', { class: 'empty-block' }, h('div', { class: 'muted-note' }, t('schedules.empty')))); return; }
    const hourRow = h('div', { class: 'tl-hours' }, ...Array.from({ length: 24 }, (_, hh) => h('span', { class: 'tl-hour' }, String(hh).padStart(2, '0'))));
    // group schedules by target
    const targets = [...new Set(schedules.map((s) => s.target))];
    const now = new Date();
    const nowPct = ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * 100;
    const tracks = targets.map((tg) => {
      const track = h('div', { class: 'tl-track' }, h('div', { class: 'now-line', style: `left:${nowPct}%` }));
      for (const s of schedules.filter((x) => x.target === tg)) {
        for (const hr of cronHours(s.cron)) {
          const pct = ((hr * 60 + cronMinute(s.cron)) / (24 * 60)) * 100;
          const marker = h('button', { class: `tl-marker${s.enabled ? '' : ' disabled'}`, style: `left:${pct}%`, title: `${s.title || s.id} - ${String(hr).padStart(2, '0')}:${String(cronMinute(s.cron)).padStart(2, '0')}`, onclick: () => openScheduleModal({ schedule: s, roster, onSaved: reload }) }, framedAvatar(labelOf(s.target), accentOf(s.target), 22));
          track.append(marker);
        }
      }
      return h('div', { class: 'tl-row' }, h('div', { class: 'tl-label' }, labelOf(tg)), track);
    });
    mount(viewBox, h('div', { class: 'timeline' }, h('div', { class: 'tl-head' }, h('div', { class: 'tl-label' }), hourRow), ...tracks));
  };

  // ---------------------------------------------------------------- week
  let expandedDay = -1; // -1 = today
  const renderWeek = (): void => {
    const today = (new Date().getDay() + 6) % 7; // Mon-first 0..6
    const focus = expandedDay === -1 ? today : expandedDay;
    const cols = Array.from({ length: 7 }, (_, d) => {
      const dayScheds = schedules.filter((s) => s.enabled && cronWeekdaysMonFirst(s.cron).includes(d));
      if (d !== focus) {
        return h('div', { class: 'week-col collapsed', onclick: () => { expandedDay = d; renderWeek(); } },
          h('div', { class: 'week-letter' }, t(`schedules.dayLetter.${d}`)),
          dayScheds.length > 0 ? h('span', { class: 'count-chip' }, String(dayScheds.length)) : null,
        );
      }
      const cards = dayScheds.sort((a, b) => (cronHours(a.cron)[0] ?? 0) - (cronHours(b.cron)[0] ?? 0)).map((s) => {
        const hr = cronHours(s.cron)[0] ?? 0;
        return h('div', { class: 'week-card', onclick: () => openScheduleModal({ schedule: s, roster, onSaved: reload }) },
          framedAvatar(labelOf(s.target), accentOf(s.target), 24),
          h('div', null, h('div', { class: 'wc-time' }, `${String(hr).padStart(2, '0')}:${String(cronMinute(s.cron)).padStart(2, '0')}`), h('div', { class: 'wc-name' }, s.title || s.id)),
        );
      });
      return h('div', { class: 'week-col expanded' },
        h('div', { class: 'week-head' }, t(`schedules.day.${d}`)),
        cards.length > 0 ? h('div', { class: 'week-cards' }, ...cards) : h('div', { class: 'muted-note' }, t('schedules.emptyDay')),
      );
    });
    mount(viewBox, h('div', { class: 'week-grid' }, ...cols));
  };

  const renderView = (): void => {
    if (viewMode === 'list') renderList();
    else if (viewMode === 'timeline') renderTimeline();
    else renderWeek();
  };

  // ---------------------------------------------------------------- pending banner
  const renderBanner = (): void => {
    if (retries.length === 0) { banner.style.display = 'none'; return; }
    banner.style.display = '';
    const agePhrase = (iso: string): string => {
      const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
      if (min < 1) return t('schedules.pending.ageNow');
      if (min < 60) return t('schedules.pending.ageMin', { n: min });
      const hrs = Math.floor(min / 60), rem = min % 60;
      return rem === 0 ? t('schedules.pending.ageHr', { n: hrs }) : t('schedules.pending.ageHrMin', { h: hrs, m: rem });
    };
    mount(banner,
      h('div', { class: 'banner-head' }, t('schedules.pending.title', { n: retries.length })),
      h('div', { class: 'field-note' }, t('schedules.pending.hint')),
      ...retries.map((r) => {
        // alert badge: "sent" once a Telegram alert went out; "due" only when past
        // the alert threshold (server-flagged) and not yet sent; otherwise nothing.
        const alertBadge = r.alerted
          ? h('span', { class: 'badge alert', title: t('schedules.pending.alertSentTip') }, t('schedules.pending.alertSent'))
          : r.alertDue
            ? h('span', { class: 'badge muted', title: t('schedules.pending.alertDueTip') }, t('schedules.pending.alertDue'))
            : null;
        return h('div', { class: 'retry-row' },
          h('div', null,
            h('div', { class: 'retry-title' }, r.taskId, h('span', { class: 'badge muted' }, labelOf(r.target)), alertBadge),
            h('div', { class: 'sched-meta' },
              h('span', null, t('schedules.pending.waiting', { n: agePhrase(r.queuedAt), k: r.attempts })),
              r.lastReason ? h('span', { class: 'retry-reason' }, t('schedules.pending.reason', { reason: r.lastReason })) : null,
            ),
          ),
          h('button', { class: 'icon-btn danger', title: t('schedules.pending.cancel'), onclick: () => void cancelRetry(r) }, icon('trash', 16)),
        );
      }),
    );
  };

  // ---------------------------------------------------------------- actions
  const toggleSchedule = async (s: ScheduledTask): Promise<void> => {
    try { await api.post(`/api/schedules/${encodeURIComponent(s.id)}/toggle`, undefined); toast(s.enabled ? t('schedules.paused') : t('schedules.resumed')); reload(); }
    catch { toast(t('schedules.genericError'), true); }
  };
  const deleteSchedule = async (s: ScheduledTask): Promise<void> => {
    if (!window.confirm(t('schedules.deleteConfirm'))) return;
    try { await api.delete(`/api/schedules/${encodeURIComponent(s.id)}`); toast(t('schedules.deleted')); reload(); }
    catch { toast(t('schedules.deleteError'), true); }
  };
  const cancelRetry = async (r: RetryRow): Promise<void> => {
    if (!window.confirm(t('schedules.pending.cancelConfirm'))) return;
    try { await api.post(`/api/schedules/retries/${r.id}/cancel`, undefined); reload(); }
    catch { toast(t('schedules.genericError'), true); }
  };

  // ---------------------------------------------------------------- gentle poll (§7)
  // The pending queue and the timeline "now" line refresh without a manual reload:
  // re-fetch the retry queue (so a newly-stuck job surfaces) and nudge the now-line
  // to real time. Lightweight — it does not refetch the schedule list or re-mount
  // the active sub-view (avoids resetting scroll / the week's expanded day).
  const updateNowLine = (): void => {
    const now = new Date();
    const pct = ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * 100;
    for (const el of viewBox.querySelectorAll<HTMLElement>('.now-line')) el.style.left = `${pct}%`;
  };
  const poll = async (): Promise<void> => {
    try { retries = await api.get<RetryRow[]>('/api/schedules/retries'); renderBanner(); } catch { /* keep last good render */ }
    updateNowLine();
  };

  // ---------------------------------------------------------------- load
  const load = async (): Promise<void> => {
    try {
      const [agents, list, pend] = await Promise.all([
        api.get<RosterAgent[]>('/api/agents'),
        api.get<ScheduledTask[]>('/api/schedules'),
        api.get<RetryRow[]>('/api/schedules/retries').catch(() => [] as RetryRow[]),
      ]);
      roster = agents;
      schedules = list;
      retries = pend;
      renderBanner();
      renderView();
    } catch {
      /* keep last good render */
    }
  };

  // ---------------------------------------------------------------- shell
  const modeBtn = (mode: ViewMode, iconName: string, titleKey: string): HTMLElement =>
    h('button', { class: `mode-btn${viewMode === mode ? ' active' : ''}`, title: t(titleKey), onclick: () => { viewMode = mode; for (const b of header.querySelectorAll('.mode-btn')) b.classList.remove('active'); renderView(); rebuildHeader(); } }, icon(iconName, 16));

  const header = h('div', { class: 'page-header sched-header' });
  const rebuildHeader = (): void => {
    mount(header,
      h('div', null, h('h1', null, t('schedules.title')), h('p', { class: 'subtitle' }, t('schedules.subtitle'))),
      h('div', { class: 'sched-actions-cluster' },
        h('div', { class: 'mode-toggle' }, modeBtn('list', 'list', 'schedules.view.list'), modeBtn('timeline', 'timelineAxis', 'schedules.view.timeline'), modeBtn('week', 'weekgrid', 'schedules.view.week')),
        h('button', { class: 'primary new-task-btn', onclick: () => openScheduleModal({ roster, onSaved: reload }) }, icon('plus', 16), t('schedules.newTask')),
      ),
    );
  };
  rebuildHeader();

  mount(host, header, banner, viewBox);
  void load();
  // gentle poll (§7) — self-cancels once this view is replaced by a route change
  const pollTimer = window.setInterval(() => { if (viewBox.isConnected) void poll(); else window.clearInterval(pollTimer); }, 15_000);
}

defineView('schedules', 'nav.schedules', render);
