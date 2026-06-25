// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from './dom.js';
import { t, currentLocale } from './i18n.js';
import { api, ApiError } from './api.js';
import { framedAvatar } from './framedAvatar.js';
import { toast } from './toast.js';
import { avatarPicker } from './avatarPicker.js';
import { openSkillEditor } from './skillEditor.js';
import { mountChannelPanel } from './components/channelPanel.js';
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
 * Agent detail modal (PROMPT-03 §5B) — the full five-tab inspector:
 * Overview / Settings / Channel / Skills / Team. The hub is special-cased
 * (identity files read-only, no delete, "Channels restart" instead of Start/Stop).
 * Delete is shown only for non-hub, non-seed agents (the backend refuses to
 * delete the base roster). Opened from the Agents view and the Overview.
 */

type TabId = 'overview' | 'settings' | 'channel' | 'skills' | 'team';

interface AgentDetail {
  id: string;
  displayName: string;
  role: string;
  accentColor: string;
  securityProfile: string;
  model: string | null;
  team: { role?: string; reportsTo?: string; delegatesTo?: string[]; trustFrom?: string[]; autoDelegation?: boolean };
  channel: { provider: string; chatId?: string } | null;
  running: boolean;
  busyState: string;
  needsReauth?: boolean;
  desired: string;
  isHub: boolean;
  isSeed: boolean;
}
interface AgentStatus {
  running: boolean;
  since?: string;
  busyState: string;
  needsReauth: boolean;
}
interface RosterEntry {
  id: string;
  displayName: string;
  isHub?: boolean;
}
interface SkillMeta {
  name: string;
  description: string;
  scope: 'global' | 'local';
  pinned: boolean;
}
interface AutoRestart {
  enabled: boolean;
  mode: 'continue' | 'fresh';
  schedule: 'daily' | 'hourly';
  dailyTime: string;
  intervalHours: number;
}
interface DocsShape {
  persona: string;
  operating: string;
  effectiveClaude: string;
  mcpJson: string;
  mcpReadOnly: boolean;
}

function err(e: unknown): void {
  toast(e instanceof ApiError ? e.message : t('agents.error'), true);
}

function field(labelKey: string, control: HTMLElement, note?: HTMLElement | null): HTMLElement {
  return h('div', { class: 'field' }, h('label', null, t(labelKey)), control, note ?? null);
}

function infoRow(labelKey: string, value: string | HTMLElement): HTMLElement {
  return h('div', { class: 'info-row' }, h('span', { class: 'info-label' }, t(labelKey)), h('span', { class: 'info-value' }, value));
}

export async function openAgentModal(id: string, onChange: () => void, opts?: { tab?: TabId }): Promise<void> {
  let agent: AgentDetail;
  let roster: RosterEntry[];
  try {
    [agent, roster] = await Promise.all([
      api.get<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`),
      api.get<RosterEntry[]>('/api/agents'),
    ]);
  } catch (e) {
    err(e);
    return;
  }
  const others = roster.filter((a) => a.id !== agent.id);

  let activeTab: TabId = opts?.tab ?? 'overview';
  let models: ModelsDto | null = null;
  let profiles: ProfileEntry[] = [];

  const body = h('div', { class: 'agent-modal-body' });
  const tabStrip = h('div', { class: 'agent-modal-tabs' });
  const footer = h('div', { class: 'agent-modal-actions' });

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

  const reloadAgent = async (): Promise<void> => {
    try {
      agent = await api.get<AgentDetail>(`/api/agents/${encodeURIComponent(agent.id)}`);
    } catch {
      /* keep last */
    }
    onChange();
  };

  // ---------------------------------------------------------------- Overview
  const channelChip = (): HTMLElement => {
    const on = agent.channel !== null;
    return h('span', { class: `chan-chip${on ? ' on' : ''}` }, h('span', { class: 'dot' }), on ? t('agents.channel.connected') : t('agents.channel.notLinked'));
  };

  const renderOverview = (): void => {
    const avatarWrap = h('div', { class: 'av-edit' }, framedAvatar(agent.displayName, agent.accentColor, 88));
    const drawer = h('div', { class: 'avatar-drawer', style: 'display:none' });
    const pencil = h('button', { class: 'icon-btn pencil-btn', 'aria-label': t('agents.avatar.change'), onclick: () => {
      drawer.style.display = drawer.style.display === 'none' ? '' : 'none';
    } }, '✎');
    mount(drawer, avatarPicker(agent.displayName, agent.accentColor, (accent) => {
      void (async () => {
        try {
          await api.patch(`/api/agents/${encodeURIComponent(agent.id)}`, { accentColor: accent });
          agent.accentColor = accent;
          toast(t('agents.avatar.saved'));
          await reloadAgent();
          renderTab();
        } catch (e) {
          err(e);
        }
      })();
    }));

    const statusDot = h('span', { class: 'dot idle' });
    const statusText = h('span', null, t('agents.run.stopped'));
    const sessionHint = h('span', { class: 'session-hint' });
    const controls = h('div', { class: 'proc-controls' });
    const reauthBanner = h('div', { class: 'notice warn reauth-banner', style: 'display:none' }, t('agents.reauth'));
    // 2-phase re-auth (FIX-03 §2): idle → 'start' (operator types /login in the
    // terminal) → 'confirm' re-checks completion. No credentials are ever injected.
    let loginPhase: 'idle' | 'confirm' = 'idle';
    const doLogin = (btn: HTMLButtonElement, st: AgentStatus): void => {
      btn.disabled = true;
      void (async () => {
        try {
          if (loginPhase === 'idle') {
            await api.post(`/api/agents/${encodeURIComponent(agent.id)}/login`, { phase: 'start' });
            toast(t('agents.reauth.hint'));
            loginPhase = 'confirm';
            renderControls(st);
          } else {
            const r = await api.post<{ status: string }>(`/api/agents/${encodeURIComponent(agent.id)}/login`, { phase: 'confirm' });
            if (r.status === 'reauth-complete') {
              toast(t('agents.reauth.complete'));
              loginPhase = 'idle';
              await reloadAgent();
              void refreshStatus();
            } else {
              toast(t('agents.reauth.pending'), true);
              btn.disabled = false;
            }
          }
        } catch (e) {
          err(e);
          btn.disabled = false;
        }
      })();
    };

    const renderControls = (st: AgentStatus): void => {
      statusDot.className = `dot ${!st.running ? 'idle' : st.busyState === 'ready' ? 'ok' : st.busyState === 'busy' ? 'busy' : 'warn'}`;
      statusText.textContent = st.running ? t('agents.run.running') : t('agents.run.stopped');
      sessionHint.textContent = st.running && st.since ? t('agents.run.since', { ts: new Date(st.since).toLocaleString(currentLocale()) }) : '';
      const reauth = st.needsReauth === true && !agent.isHub;
      reauthBanner.style.display = reauth ? '' : 'none';
      const buttons: HTMLElement[] = [];
      if (reauth) {
        const loginBtn = h('button', { class: 'primary' }, t(loginPhase === 'confirm' ? 'agents.reauth.confirm' : 'agents.login')) as HTMLButtonElement;
        loginBtn.addEventListener('click', () => doLogin(loginBtn, st));
        buttons.push(loginBtn);
      } else if (agent.isHub) {
        buttons.push(h('button', { class: 'danger', onclick: () => void channelsRestart() }, t('agents.channelsRestart')));
      } else if (st.running) {
        buttons.push(h('button', { class: 'danger', onclick: () => void stop() }, t('agents.stop')));
      } else {
        buttons.push(h('button', { class: 'primary', onclick: () => void start() }, t('agents.start')));
      }
      mount(controls, ...buttons);
    };

    const start = async (): Promise<void> => {
      try {
        await api.post(`/api/agents/${encodeURIComponent(agent.id)}/start`, undefined);
        toast(t('agents.started'));
        await reloadAgent();
        void refreshStatus();
      } catch (e) {
        err(e);
      }
    };
    const stop = async (): Promise<void> => {
      if (!window.confirm(t('agents.stopConfirm'))) return;
      try {
        await api.post(`/api/agents/${encodeURIComponent(agent.id)}/stop`, undefined);
        toast(t('agents.stopped'));
        await reloadAgent();
        void refreshStatus();
      } catch (e) {
        err(e);
      }
    };
    const channelsRestart = async (): Promise<void> => {
      if (!window.confirm(t('agents.channelsRestartConfirm'))) return;
      try {
        await api.post('/api/hub/restart', { fresh: false });
        toast(t('agents.channelsRestarted'));
      } catch (e) {
        err(e);
      }
    };
    const refreshStatus = async (): Promise<void> => {
      try {
        renderControls(await api.get<AgentStatus>(`/api/agents/${encodeURIComponent(agent.id)}/status`));
      } catch {
        /* keep last */
      }
    };

    const skillsCountEl = h('span', { class: 'info-value' }, '—');
    void api.get<SkillMeta[]>(`/api/skills/agent/${encodeURIComponent(agent.id)}`).then((s) => {
      skillsCountEl.textContent = String(s.length);
    }).catch(() => undefined);

    // Context (FIX-03 §5): no true context-window telemetry exists in this stack,
    // so show an HONEST 24h token-usage proxy (~Nk), never a fabricated window size.
    const contextEl = h('span', { class: 'info-value' }, '—');
    void (async () => {
      try {
        const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const rows = await api.get<Array<{ agent: string; totalInput: number; totalOutput: number }>>(`/api/token-usage/summary?from=${encodeURIComponent(from)}`);
        const row = rows.find((r) => r.agent === agent.id);
        if (row) {
          const total = row.totalInput + row.totalOutput;
          const k = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
          contextEl.textContent = t('agents.field.contextUsage', { tokens: k });
        }
      } catch { /* leave the dash */ }
    })();

    mount(
      body,
      h('div', { class: 'agent-modal-head', style: `--ac: ${agent.accentColor}` }, avatarWrap, pencil, h('div', { class: 'agent-modal-id' }, h('div', { class: 'agent-modal-name' }, agent.displayName), h('div', { class: 'agent-modal-role' }, agent.role), channelChip())),
      drawer,
      h(
        'div',
        { class: 'agent-modal-info' },
        infoRow('agents.field.model', agent.model ?? t('agents.model.inherit')),
        h('div', { class: 'info-row' }, h('span', { class: 'info-label' }, t('agents.field.channel')), h('span', null, channelChip())),
        h('div', { class: 'info-row' }, h('span', { class: 'info-label' }, t('agents.field.skills')), skillsCountEl),
        h('div', { class: 'info-row' }, h('span', { class: 'info-label' }, t('agents.field.context')), contextEl),
      ),
      reauthBanner,
      h('div', { class: 'proc-row' }, statusDot, statusText, sessionHint, controls),
    );
    renderControls({ running: agent.running, busyState: agent.busyState, needsReauth: agent.needsReauth ?? false });
    void refreshStatus();
  };

  // ---------------------------------------------------------------- Settings
  const ensureCatalogs = async (): Promise<void> => {
    if (!models) models = await fetchModels();
    if (profiles.length === 0) profiles = await fetchProfiles();
  };

  const renderSettings = (): void => {
    mount(body, h('div', { class: 'muted-note' }, t('agents.loading')));
    void (async () => {
      try {
        // the hub edits only its identity (persona/operating) — skip the catalogs +
        // model/profile/auth surfaces it doesn't have (it's the fixed root).
        if (!agent.isHub) await ensureCatalogs();
        const docs = await api.get<DocsShape>(`/api/agents/${encodeURIComponent(agent.id)}/docs`);
        const ar = agent.isHub ? null : await api.get<AutoRestart>(`/api/agents/${encodeURIComponent(agent.id)}/auto-restart`);
        buildSettings(docs, ar);
      } catch (e) {
        err(e);
      }
    })();
  };

  const buildSettings = (docs: DocsShape, ar: AutoRestart | null): void => {
    // shared section helpers
    const saveBtn = (fn: () => void): HTMLElement => h('button', { class: 'primary save-btn', onclick: fn }, t('agents.save'));
    const section = (titleKey: string, ...kids: (HTMLElement | null)[]): HTMLElement =>
      h('div', { class: 'settings-section' }, h('div', { class: 'sec-title' }, t(titleKey)), ...kids.filter((x): x is HTMLElement => x !== null));
    const docTextarea = (value: string, rows: number, readonly = false): HTMLTextAreaElement => {
      const el = h('textarea', { class: `mono${readonly ? ' readonly' : ''}`, rows }) as HTMLTextAreaElement;
      el.value = value;
      if (readonly) el.readOnly = true;
      return el;
    };

    // identity docs — the REAL persona.md + operating.md at the agent root
    // (FIX-agent-card-persona), editable for EVERY agent incl. the hub; the combined
    // CLAUDE.md is a read-only preview re-rendered server-side on save.
    const personaEl = docTextarea(docs.persona, 10);
    const operatingEl = docTextarea(docs.operating, 12);
    const effectiveEl = docTextarea(docs.effectiveClaude, 8, true);
    const mcpEl = docTextarea(docs.mcpJson, 5, docs.mcpReadOnly);
    const saveDoc = (key: 'persona' | 'operating' | 'mcpJson', el: HTMLTextAreaElement) => async (): Promise<void> => {
      try { await api.put(`/api/agents/${encodeURIComponent(agent.id)}/docs`, { [key]: el.value }); toast(t('agents.settings.docSaved')); }
      catch (e) { err(e); }
    };
    const docsSections: HTMLElement[] = [
      section('agents.settings.persona', personaEl, saveBtn(saveDoc('persona', personaEl))),
      section('agents.settings.operating', operatingEl, saveBtn(saveDoc('operating', operatingEl))),
      section('agents.settings.effective', h('p', { class: 'field-note' }, t('agents.settings.effectiveNote')), effectiveEl),
      docs.mcpReadOnly
        ? section('agents.settings.mcpJson', h('p', { class: 'field-note' }, t('agents.settings.mcpHubReadonly')), mcpEl)
        : section('agents.settings.mcpJson', mcpEl, saveBtn(saveDoc('mcpJson', mcpEl))),
    ];

    // the hub is the fixed root: no model/profile/auth/auto-restart surface here, just identity
    if (agent.isHub || ar === null) { mount(body, ...docsSections); return; }

    // model
    const modelSel = buildModelSelect(models!, agent.model);
    const modelChip = h('span', { class: 'restart-chip', style: 'display:none' }, t('agents.settings.restarting'));
    const saveModel = async (): Promise<void> => {
      const value = modelSel.value === 'inherit' ? '' : modelSel.value;
      const id = encodeURIComponent(agent.id);
      try {
        const before = (await api.get<AgentStatus>(`/api/agents/${id}/status`)).since;
        await api.patch(`/api/agents/${id}`, { model: value });
        await api.post(`/api/agents/${id}/restart`, { fresh: false });
        toast(t('agents.settings.modelSaved', { model: value || t('agents.model.inherit') }));
        // poll until the session start-time advances (the honest restart signal),
        // ~2s up to ~60s; a "restarting" chip rides the Model row meanwhile (FIX-03 §4)
        modelChip.style.display = '';
        let advanced = false;
        for (let i = 0; i < 30 && backdrop.isConnected; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const st = await api.get<AgentStatus>(`/api/agents/${id}/status`);
            if (st.running && st.since !== undefined && st.since !== before) { advanced = true; break; }
          } catch { /* transient; keep polling */ }
        }
        modelChip.style.display = 'none';
        toast(advanced ? t('agents.settings.modelRestarted') : t('agents.settings.modelRestartTimeout'), !advanced);
        await reloadAgent();
      } catch (e) {
        modelChip.style.display = 'none';
        err(e);
      }
    };

    // profile
    const profileSel = buildProfileSelect(profiles, agent.securityProfile);
    const profDesc = h('div', { class: 'field-note' }, profileDescription(profiles, agent.securityProfile));
    profileSel.addEventListener('change', () => { profDesc.textContent = profileDescription(profiles, profileSel.value); });
    const saveProfile = async (): Promise<void> => {
      try {
        await api.patch(`/api/agents/${encodeURIComponent(agent.id)}`, { securityProfile: profileSel.value });
        toast(t('agents.settings.profileSaved'));
        await reloadAgent();
      } catch (e) {
        err(e);
      }
    };

    // auto-restart
    const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = ar.enabled;
    const modeSel = h('select', null, h('option', { value: 'continue', selected: ar.mode === 'continue' }, t('agents.autoRestart.continue')), h('option', { value: 'fresh', selected: ar.mode === 'fresh' }, t('agents.autoRestart.fresh'))) as HTMLSelectElement;
    const schedSel = h('select', null, h('option', { value: 'daily', selected: ar.schedule === 'daily' }, t('agents.autoRestart.daily')), h('option', { value: 'hourly', selected: ar.schedule === 'hourly' }, t('agents.autoRestart.hourly'))) as HTMLSelectElement;
    const timeEl = h('input', { type: 'time', value: ar.dailyTime }) as HTMLInputElement;
    const hoursEl = h('input', { type: 'number', min: '1', max: '168', value: String(ar.intervalHours) }) as HTMLInputElement;
    const timeField = field('agents.autoRestart.time', timeEl);
    const hoursField = field('agents.autoRestart.everyN', hoursEl);
    const syncSched = (): void => {
      timeField.style.display = schedSel.value === 'daily' ? '' : 'none';
      hoursField.style.display = schedSel.value === 'hourly' ? '' : 'none';
    };
    schedSel.addEventListener('change', syncSched);
    syncSched();
    const saveAuto = async (): Promise<void> => {
      try {
        await api.put(`/api/agents/${encodeURIComponent(agent.id)}/auto-restart`, {
          enabled: enabled.checked,
          mode: modeSel.value,
          schedule: schedSel.value,
          dailyTime: timeEl.value,
          intervalHours: Number(hoursEl.value),
        });
        toast(t('agents.saved'));
      } catch (e) {
        err(e);
      }
    };

    // auth-mode (subscription-only: api-key card disabled) + per-mode action sub-panel (§5f)
    const authCards = h('div', { class: 'radio-cards' });
    const authSub = h('div', { class: 'auth-subpanel' });
    const authErr = h('div', { class: 'inline-error', style: 'display:none' });
    let authMode: 'shared-subscription' | 'own-credentials' = 'shared-subscription';
    const authOptions: Array<{ id: 'shared-subscription' | 'own-credentials' | 'api-key'; titleKey: string; descKey: string; disabled?: boolean }> = [
      { id: 'shared-subscription', titleKey: 'agents.auth.shared', descKey: 'agents.auth.sharedDesc' },
      { id: 'own-credentials', titleKey: 'agents.auth.own', descKey: 'agents.auth.ownDesc' },
      { id: 'api-key', titleKey: 'agents.auth.apiKey', descKey: 'agents.auth.apiKeyDisabled', disabled: true },
    ];
    const showAuthErr = (e: unknown): void => { authErr.style.display = ''; authErr.textContent = e instanceof ApiError ? e.message : t('agents.error'); };
    // Shared → apply the host login (restart the agent so it picks up the host OAuth).
    const applyHostLogin = async (btn: HTMLButtonElement): Promise<void> => {
      authErr.style.display = 'none'; btn.disabled = true;
      try { await api.post(`/api/agents/${encodeURIComponent(agent.id)}/restart`, {}); toast(t('agents.auth.applyHost.done')); await reloadAgent(); }
      catch (e) { showAuthErr(e); btn.disabled = false; }
    };
    // Own-team → start a fresh login flow in the agent's session; surface the auth URL.
    const startOwnLogin = async (btn: HTMLButtonElement, urlBox: HTMLElement): Promise<void> => {
      authErr.style.display = 'none'; mount(urlBox); urlBox.style.display = 'none';
      btn.disabled = true; const label = btn.textContent; btn.textContent = t('agents.auth.login.starting');
      try {
        const r = await api.post<{ started: boolean; url: string | null }>(`/api/agents/${encodeURIComponent(agent.id)}/auth-login`, {});
        if (r.url) {
          mount(urlBox,
            h('a', { class: 'auth-url-link', href: r.url, target: '_blank', rel: 'noopener' }, r.url),
            h('button', { class: 'link-btn', onclick: () => { void navigator.clipboard?.writeText(r.url!); toast(t('agents.auth.copied')); } }, t('agents.auth.copy')),
          );
        } else {
          mount(urlBox, h('span', { class: 'field-note' }, t('agents.auth.login.started')));
        }
        urlBox.style.display = '';
      } catch (e) { showAuthErr(e); }
      finally { btn.disabled = false; btn.textContent = label ?? t('agents.auth.login.btn'); }
    };
    const paintAuthSub = (): void => {
      authErr.style.display = 'none'; authErr.textContent = ''; // clear a stale error when the mode changes
      if (authMode === 'shared-subscription') {
        const btn = h('button', { class: 'secondary', onclick: () => void applyHostLogin(btn) }, t('agents.auth.applyHost.btn')) as HTMLButtonElement;
        mount(authSub, h('div', { class: 'auth-row' }, h('span', { class: 'field-note' }, t('agents.auth.applyHost.label')), btn), authErr);
      } else if (authMode === 'own-credentials') {
        const urlBox = h('div', { class: 'auth-url', style: 'display:none' });
        const btn = h('button', { class: 'secondary', onclick: () => void startOwnLogin(btn, urlBox) }, t('agents.auth.login.btn')) as HTMLButtonElement;
        mount(authSub, h('div', { class: 'auth-row' }, h('span', { class: 'field-note' }, t('agents.auth.login.label')), btn), urlBox, authErr);
      } else {
        mount(authSub);
      }
    };
    const paintAuth = (): void => {
      mount(
        authCards,
        ...authOptions.map((o) =>
          h(
            'button',
            { class: `radio-card${authMode === o.id ? ' active' : ''}${o.disabled ? ' disabled' : ''}`, type: 'button', onclick: () => { if (o.disabled) return; authMode = o.id as typeof authMode; paintAuth(); } },
            h('div', { class: 'rc-title' }, t(o.titleKey)),
            h('div', { class: 'rc-desc' }, t(o.descKey)),
            // API-key stays disabled (subscription-only) with an explicit status line (§5f / FIX-20)
            o.id === 'api-key' ? h('div', { class: 'rc-status muted-note' }, t('agents.auth.apiKey.unavailable')) : null,
          ),
        ),
      );
      paintAuthSub();
    };
    paintAuth();
    const saveAuth = async (): Promise<void> => {
      try {
        await api.put(`/api/agents/${encodeURIComponent(agent.id)}/auth-mode`, { authMode });
        toast(t('agents.auth.saved'));
        await reloadAgent();
      } catch (e) {
        err(e);
      }
    };

    mount(
      body,
      section('agents.field.model', field('agents.field.model', modelSel), modelChip, saveBtn(() => void saveModel())),
      section('agents.autoRestart.title',
        h('p', { class: 'field-note' }, t('agents.autoRestart.note')),
        h('label', { class: 'inline-check' }, enabled, t('agents.autoRestart.enabled')),
        field('agents.autoRestart.mode', modeSel),
        field('agents.autoRestart.schedule', schedSel),
        timeField,
        hoursField,
        saveBtn(() => void saveAuto()),
      ),
      section('agents.auth.title', authCards, authSub, saveBtn(() => void saveAuth())),
      section('agents.field.profile', field('agents.field.profile', profileSel, profDesc), saveBtn(() => void saveProfile())),
      ...docsSections,
    );
  };

  // ---------------------------------------------------------------- Channel
  // The full channel surface is the SHARED component (FIX-channels), mounted here
  // in agent scope. It owns provider selection, bound chats, invites, pairings,
  // setup instructions and the connect/test/disconnect actions.
  const renderChannel = (): void => {
    const slot = h('div', { class: 'channel-slot' });
    mount(body, slot);
    mountChannelPanel(slot, { scope: 'agent', agentId: agent.id, onChange: () => { void reloadAgent(); } });
  };

  // ---------------------------------------------------------------- Skills
  const renderSkills = (): void => {
    const list = h('div', { class: 'skill-list' }, h('div', { class: 'muted-note' }, t('agents.loading')));
    const load = async (): Promise<void> => {
      try {
        const skills = await api.get<SkillMeta[]>(`/api/skills/agent/${encodeURIComponent(agent.id)}`);
        if (skills.length === 0) {
          mount(list, h('div', { class: 'muted-note' }, t('agents.skills.empty')));
          return;
        }
        mount(
          list,
          ...skills.map((s) =>
            h(
              'div',
              { class: 'skill-row' },
              h('div', { class: 'skill-main' }, h('span', { class: 'skill-name' }, s.name), s.scope === 'global' ? h('span', { class: 'badge muted' }, t('agents.skills.global')) : null, s.description ? h('span', { class: 'skill-desc' }, s.description) : null),
              s.scope === 'local' && !s.pinned ? h('button', { class: 'icon-btn danger', 'aria-label': t('agents.skills.delete'), onclick: () => void del(s) }, '🗑') : null,
            ),
          ),
        );
      } catch (e) {
        err(e);
      }
    };
    const del = async (s: SkillMeta): Promise<void> => {
      if (!window.confirm(t('agents.skills.deleteConfirm', { name: s.name }))) return;
      try {
        await api.delete(`/api/skills/local/${encodeURIComponent(s.name)}?agent=${encodeURIComponent(agent.id)}`);
        toast(t('agents.skills.deleted'));
        void load();
      } catch (e) {
        err(e);
      }
    };
    mount(
      body,
      h('div', { class: 'skills-head' }, h('div', { class: 'sec-title' }, t('agents.skills.title')), h('button', { class: 'primary', onclick: () => openSkillEditor(agent.id, () => void load()) }, t('agents.skills.new'))),
      list,
    );
    void load();
  };

  // ---------------------------------------------------------------- Team
  const renderTeam = (): void => {
    if (agent.isHub) {
      mount(body, h('div', { class: 'notice' }, t('agents.team.hubNote')));
      return;
    }
    let role = agent.team.role === 'leader' ? 'leader' : 'member';
    const roleSel = h('select', { 'aria-label': t('agents.team.role') }, h('option', { value: 'member', selected: role === 'member' }, t('agents.team.member')), h('option', { value: 'leader', selected: role === 'leader' }, t('agents.team.leader'))) as HTMLSelectElement;
    const reportsSel = h('select', { 'aria-label': t('agents.team.reportsTo') }, h('option', { value: '', selected: !agent.team.reportsTo }, t('agents.team.orchestrator')), ...others.map((o) => h('option', { value: o.id, selected: agent.team.reportsTo === o.id }, o.displayName))) as HTMLSelectElement;

    const delegates = new Set(agent.team.delegatesTo ?? []);
    const trust = new Set(agent.team.trustFrom ?? []);
    const checkList = (set: Set<string>): HTMLElement =>
      h('div', { class: 'check-list' }, ...others.map((o) => {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = set.has(o.id);
        cb.addEventListener('change', () => { if (cb.checked) set.add(o.id); else set.delete(o.id); });
        return h('label', { class: 'inline-check' }, cb, o.displayName);
      }));
    const delegateList = checkList(delegates);
    const autoDeleg = h('input', { type: 'checkbox' }) as HTMLInputElement;
    autoDeleg.checked = agent.team.autoDelegation === true;
    const leaderBlock = h(
      'div',
      { class: 'leader-block' },
      field('agents.team.delegatesTo', delegateList),
      h('label', { class: 'inline-check' }, autoDeleg, t('agents.team.autoDelegate')),
      h('div', { class: 'field-note' }, t('agents.team.autoDelegateNote')),
    );
    const syncRole = (): void => { leaderBlock.style.display = roleSel.value === 'leader' ? '' : 'none'; };
    roleSel.addEventListener('change', syncRole);
    syncRole();

    const saveBtn = h('button', { class: 'primary', onclick: (e: Event) => void save(e) }, t('agents.save')) as HTMLButtonElement;
    const save = async (e: Event): Promise<void> => {
      const btn = e.currentTarget as HTMLButtonElement;
      const isLeader = roleSel.value === 'leader';
      btn.disabled = true;
      btn.textContent = t('agents.team.saving');
      try {
        const res = await api.put<{ warnings: { selfReferences: string[]; unknownNames: string[] } }>(
          `/api/agents/${encodeURIComponent(agent.id)}/team`,
          {
            role: roleSel.value,
            reportsTo: reportsSel.value || null,
            delegatesTo: isLeader ? [...delegates] : [],
            autoDelegation: isLeader && autoDeleg.checked,
            trustFrom: [...trust],
          },
        );
        const removed: string[] = [];
        if (res.warnings.selfReferences.length) removed.push(`${t('agents.team.selfRefs')}: ${res.warnings.selfReferences.join(', ')}`);
        if (res.warnings.unknownNames.length) removed.push(`${t('agents.team.unknownNames')}: ${res.warnings.unknownNames.join(', ')}`);
        toast(removed.length ? t('agents.team.savedWith', { removed: removed.join('; ') }) : t('agents.team.saved'));
        btn.textContent = t('agents.team.savedCheck');
        await reloadAgent();
        setTimeout(() => { btn.textContent = t('agents.save'); btn.disabled = false; }, 1200);
      } catch (er) {
        toast(er instanceof ApiError ? er.message : t('agents.team.error'), true);
        btn.textContent = t('agents.save');
        btn.disabled = false;
      }
    };

    mount(
      body,
      field('agents.team.role', roleSel),
      field('agents.team.reportsTo', reportsSel, h('div', { class: 'field-note' }, t('agents.team.reportsNote'))),
      leaderBlock,
      field('agents.team.trustFrom', checkList(trust), h('div', { class: 'field-note' }, t('agents.team.trustNote'))),
      h('div', { class: 'modal-actions' }, saveBtn),
    );
  };

  // ---------------------------------------------------------------- shell
  const remove = (): void => {
    if (!window.confirm(t('agents.deleteConfirm', { name: agent.displayName }))) return;
    void (async () => {
      try {
        await api.delete(`/api/agents/${encodeURIComponent(agent.id)}`);
        close();
        toast(t('agents.deleted'));
        onChange();
      } catch (e) {
        err(e);
      }
    })();
  };

  const renderFooter = (): void => {
    if (!agent.isHub && !agent.isSeed) {
      mount(footer, h('div', { class: 'spacer-actions' }), h('button', { class: 'danger', onclick: remove }, t('agents.delete')));
    } else {
      mount(footer);
    }
  };

  const renderTab = (): void => {
    if (activeTab === 'overview') renderOverview();
    else if (activeTab === 'settings') renderSettings();
    else if (activeTab === 'channel') renderChannel();
    else if (activeTab === 'skills') renderSkills();
    else renderTeam();
  };

  const tabDef: Array<[TabId, string]> = [
    ['overview', 'agents.tab.overview'],
    ['settings', 'agents.tab.settings'],
    ['channel', 'agents.tab.channel'],
    ['skills', 'agents.tab.skills'],
    ['team', 'agents.tab.team'],
  ];
  const renderTabs = (): void => {
    mount(
      tabStrip,
      ...tabDef.map(([tid, key]) =>
        h('button', { class: `tab${tid === activeTab ? ' active' : ''}`, 'data-tab': tid, onclick: () => { activeTab = tid; renderTabs(); renderTab(); } }, t(key)),
      ),
    );
  };

  backdrop.append(
    h(
      'div',
      { class: 'modal agent-modal', style: `--ac: ${agent.accentColor}` },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, agent.displayName), h('button', { class: 'icon-btn', 'aria-label': t('agents.close'), onclick: close }, '✕')),
      tabStrip,
      body,
      footer,
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  renderTabs();
  renderTab();
  renderFooter();
}
