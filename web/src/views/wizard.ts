// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * First-run onboarding wizard (BUILD-onboarding-wizard). A non-programmer-friendly
 * setup checklist with LIVE status: it READS /api/onboarding/status to know what's set,
 * and WRITES via the existing endpoints (channel config, vault integrations) when the
 * operator fills a step. ONE step is REQUIRED — subscription auth; everything else is
 * OPTIONAL + clearly SKIPPABLE (the system works without it). Every step has: a one-line
 * "what this gives you", plain-language steps with exact commands/click-paths, a Test
 * button that reports success/failure in human terms, and Skip. Tokens go ONLY to the
 * vault (never echoed back). Operator-gated by the API. HU + EN throughout.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';

interface StepState { configured?: boolean; done?: boolean; present?: boolean; expired?: boolean; mode?: 'subscription' | 'api'; apiKeySet?: boolean }
interface OnboardingStatus {
  completed: boolean;
  dismissed: boolean;
  steps: { auth: StepState; telegram: StepState; discord: StepState; ollama: StepState; comfy: StepState };
}

const errMsg = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));
const skipped = new Set<string>(); // local "set up later" choices (UI only)

function render(host: HTMLElement): void {
  const body = h('div', { class: 'wizard-steps' });
  mount(
    host,
    h('div', { class: 'page-header' },
      h('div', null, h('h1', null, t('wizard.title')), h('p', { class: 'subtitle' }, t('wizard.subtitle'))),
      h('button', { class: 'refresh-btn', onclick: () => void load() }, icon('refresh', 16), t('wizard.recheck')),
    ),
    body,
  );
  mount(body, h('div', { class: 'muted-note' }, t('wizard.loading')));
  void load();

  async function load(): Promise<void> {
    let st: OnboardingStatus;
    try {
      st = await api.get<OnboardingStatus>('/api/onboarding/status');
    } catch (err) {
      mount(body, h('div', { class: 'muted-note err' }, t('wizard.error', { message: errMsg(err) })));
      return;
    }
    mount(
      body,
      stepAuth(st.steps.auth),
      stepChannels(st.steps.telegram, st.steps.discord),
      stepOllama(st.steps.ollama),
      stepComfy(st.steps.comfy),
      stepFinish(st),
    );
  }

  // ---- shared step shell ----
  function badge(state: 'done' | 'skipped' | 'attention' | 'notset'): HTMLElement {
    const label =
      state === 'done' ? `✓ ${t('wizard.status.done')}`
      : state === 'skipped' ? `○ ${t('wizard.status.skipped')}`
      : state === 'attention' ? `! ${t('wizard.status.attention')}`
      : `○ ${t('wizard.status.notset')}`;
    return h('span', { class: `wiz-badge ${state}` }, label);
  }
  function stepShell(id: string, num: number, title: string, required: boolean, state: 'done' | 'skipped' | 'attention' | 'notset', what: string, ...content: (HTMLElement | null)[]): HTMLElement {
    return h('div', { class: `wiz-step${state === 'done' ? ' done' : ''}`, 'data-step': id },
      h('div', { class: 'wiz-step-head' },
        h('span', { class: 'wiz-num' }, String(num)),
        h('div', { class: 'wiz-step-titles' },
          h('div', { class: 'wiz-step-title' }, title, required ? h('span', { class: 'wiz-req' }, t('wizard.required')) : h('span', { class: 'wiz-opt' }, t('wizard.optional'))),
          h('div', { class: 'wiz-what' }, what),
        ),
        badge(state),
      ),
      ...content,
    );
  }
  const instr = (text: string): HTMLElement => h('pre', { class: 'wiz-instr' }, text);
  const field = (labelKey: string, el: HTMLElement, note?: string): HTMLElement =>
    h('label', { class: 'wiz-field' }, h('span', { class: 'wiz-flabel' }, t(labelKey)), el, note ? h('span', { class: 'wiz-note' }, note) : null);
  const input = (placeholder = ''): HTMLInputElement => h('input', { type: 'text', class: 'wiz-input', placeholder }) as HTMLInputElement;
  const skipBtn = (id: string): HTMLElement =>
    h('button', { class: 'wiz-skip', onclick: () => { skipped.add(id); void load(); } }, t('wizard.skip'));
  const testResult = (): HTMLElement => h('div', { class: 'wiz-test-result' });
  function showResult(el: HTMLElement, ok: boolean, msg: string): void {
    mount(el, h('span', { class: ok ? 'wiz-ok' : 'wiz-fail' }, `${ok ? '✓' : '✗'} ${msg}`));
  }

  // ---- Step 1: how agents think — subscription (recommended) OR API mode (REQUIRED gate) ----
  function stepAuth(s: StepState): HTMLElement {
    const state = s.done ? 'done' : 'attention';
    const apiMode = s.mode === 'api';
    const recheckOut = testResult();
    async function recheck(): Promise<void> {
      try {
        const a = await api.get<{ present: boolean; expired: boolean }>('/api/agents/shared-auth');
        if (a.present && !a.expired) { toast(t('wizard.s1.found')); void load(); }
        else showResult(recheckOut, false, t('wizard.s1.notfound'));
      } catch (err) { showResult(recheckOut, false, errMsg(err)); }
    }
    // Advanced: operator-opt-in API mode (never forbidden; subscription is just the default).
    const apiKey = input('sk-ant-…');
    const apiOut = testResult();
    async function enableApi(): Promise<void> {
      try {
        if (apiKey.value.trim()) await api.post('/api/vault', { id: 'anthropic_api_key', label: 'Anthropic API key', value: apiKey.value.trim() });
        await api.put('/api/billing', { mode: 'api' });
        apiKey.value = ''; toast(t('wizard.s1.apiSaved')); void load();
      } catch (err) { showResult(apiOut, false, errMsg(err)); }
    }
    async function backToSub(): Promise<void> {
      try { await api.put('/api/billing', { mode: 'subscription' }); toast(t('wizard.saved')); void load(); }
      catch (err) { showResult(apiOut, false, errMsg(err)); }
    }
    const apiBlock = apiMode
      ? h('div', { class: 'wiz-sub' },
          h('div', { class: 'wiz-ok' }, `✓ ${t('wizard.s1.apiOn')}`),
          h('div', { class: 'wiz-actions' }, h('button', { onclick: () => void backToSub() }, t('wizard.s1.toSub')), apiOut),
        )
      : h('details', { class: 'wiz-sub' },
          h('summary', { class: 'wiz-sub-title' }, t('wizard.s1.apiTitle')),
          instr(t('wizard.s1.apiInstr')),
          field('wizard.s1.apiKey', apiKey, t('wizard.tokenNote')),
          h('div', { class: 'wiz-actions' }, h('button', { class: 'primary', onclick: () => void enableApi() }, t('wizard.s1.useApi')), apiOut),
        );
    const content = s.done
      ? h('div', null, h('div', { class: 'wiz-ok' }, `✓ ${t(apiMode ? 'wizard.s1.okApi' : 'wizard.s1.ok')}`), apiMode ? apiBlock : null)
      : h('div', null,
          instr(t('wizard.s1.instr')),
          h('button', { class: 'primary', onclick: () => void recheck() }, t('wizard.s1.recheck')),
          recheckOut,
          apiBlock,
        );
    return stepShell('auth', 1, t('wizard.s1.title'), true, state, t('wizard.s1.what'), content);
  }

  // ---- Step 2: chat channels (OPTIONAL — Telegram and/or Discord) ----
  function stepChannels(tg: StepState, dc: StepState): HTMLElement {
    const anyDone = tg.configured || dc.configured;
    const state = anyDone ? 'done' : skipped.has('channels') ? 'skipped' : 'notset';
    // Telegram sub-step
    const tgToken = input('123456:ABC-...'); const tgChat = input('123456789');
    const tgOut = testResult();
    const tgSave = async (): Promise<void> => {
      try {
        await api.post('/api/channels/telegram', { enabled: true, ...(tgToken.value.trim() ? { token: tgToken.value.trim() } : {}), operatorChatId: tgChat.value.trim() });
        toast(t('wizard.saved')); tgToken.value = ''; void load();
      } catch (err) { toast(t('wizard.error', { message: errMsg(err) }), true); }
    };
    const tgTest = async (): Promise<void> => {
      try { const r = await api.post<{ ok: boolean }>('/api/channels/telegram/test', {}); showResult(tgOut, r.ok, r.ok ? t('wizard.tg.ok') : t('wizard.tg.fail')); }
      catch (err) { showResult(tgOut, false, errMsg(err)); }
    };
    const tgBlock = h('div', { class: 'wiz-sub' },
      h('div', { class: 'wiz-sub-title' }, t('wizard.tg.title'), tg.configured ? badge('done') : null),
      instr(t('wizard.tg.instr')),
      field('wizard.tg.token', tgToken, t('wizard.tokenNote')),
      field('wizard.tg.chatId', tgChat),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'primary', onclick: () => void tgSave() }, t('wizard.save')), h('button', { onclick: () => void tgTest() }, t('wizard.test')), tgOut),
    );
    // Discord sub-step
    const dcToken = input('MTA...'); const dcChan = input('123456789012345678'); const dcApp = input('(optional)');
    const dcOut = testResult();
    const dcSave = async (): Promise<void> => {
      try {
        await api.post('/api/channels/discord', { enabled: true, ...(dcToken.value.trim() ? { botToken: dcToken.value.trim() } : {}), operatorChatId: dcChan.value.trim(), ...(dcApp.value.trim() ? { applicationId: dcApp.value.trim() } : {}) });
        toast(t('wizard.saved')); dcToken.value = ''; void load();
      } catch (err) { toast(t('wizard.error', { message: errMsg(err) }), true); }
    };
    const dcTest = async (): Promise<void> => {
      try { const r = await api.post<{ ok: boolean }>('/api/channels/discord/test', {}); showResult(dcOut, r.ok, r.ok ? t('wizard.dc.ok') : t('wizard.dc.fail')); }
      catch (err) { showResult(dcOut, false, errMsg(err)); }
    };
    const dcBlock = h('div', { class: 'wiz-sub' },
      h('div', { class: 'wiz-sub-title' }, t('wizard.dc.title'), dc.configured ? badge('done') : null),
      instr(t('wizard.dc.instr')),
      h('div', { class: 'notice warn' }, t('wizard.dc.intentWarn')),
      field('wizard.dc.token', dcToken, t('wizard.tokenNote')),
      field('wizard.dc.channelId', dcChan),
      field('wizard.dc.appId', dcApp),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'primary', onclick: () => void dcSave() }, t('wizard.save')), h('button', { onclick: () => void dcTest() }, t('wizard.test')), dcOut),
    );
    return stepShell('channels', 2, t('wizard.s2.title'), false, state, t('wizard.s2.what'), tgBlock, dcBlock, h('div', { class: 'wiz-skiprow' }, skipBtn('channels')));
  }

  // ---- Step 3: ollama (OPTIONAL) ----
  function stepOllama(s: StepState): HTMLElement {
    const state = s.configured ? 'done' : skipped.has('ollama') ? 'skipped' : 'notset';
    const url = input('http://localhost:11434'); const embed = input('nomic-embed-text'); const model = input('(optional)');
    const out = testResult();
    const save = async (): Promise<void> => {
      try {
        const values: Record<string, string> = {};
        if (url.value.trim()) values.ollama_url = url.value.trim();
        if (embed.value.trim()) values.embedding_model = embed.value.trim();
        if (model.value.trim()) values.ollama_model = model.value.trim();
        await api.post('/api/vault/integrations', { values });
        toast(t('wizard.saved')); void load();
      } catch (err) { toast(t('wizard.error', { message: errMsg(err) }), true); }
    };
    const test = async (): Promise<void> => {
      try {
        const r = await api.get<{ state: string; models: number }>('/api/vault/ollama-status');
        showResult(out, r.state === 'reachable', r.state === 'reachable' ? t('wizard.s3.ok', { n: String(r.models) }) : t('wizard.s3.fail', { state: r.state }));
      } catch (err) { showResult(out, false, errMsg(err)); }
    };
    return stepShell('ollama', 3, t('wizard.s3.title'), false, state, t('wizard.s3.what'),
      instr(t('wizard.s3.instr')),
      field('wizard.s3.url', url), field('wizard.s3.embed', embed), field('wizard.s3.model', model),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'primary', onclick: () => void save() }, t('wizard.save')), h('button', { onclick: () => void test() }, t('wizard.test')), out),
      h('div', { class: 'wiz-skiprow' }, skipBtn('ollama')),
    );
  }

  // ---- Step 4: ComfyUI (OPTIONAL — GPU) ----
  function stepComfy(s: StepState): HTMLElement {
    const state = s.configured ? 'done' : skipped.has('comfy') ? 'skipped' : 'notset';
    const url = input('http://gpu-box:8188'); const ssh = input('(optional) user@host'); const ckpt = input('(optional) sd_xl_base_1.0.safetensors');
    const out = testResult();
    const save = async (): Promise<void> => {
      try {
        const values: Record<string, string> = {};
        if (url.value.trim()) values.comfy_url = url.value.trim();
        if (ssh.value.trim()) values.comfy_ssh = ssh.value.trim();
        if (ckpt.value.trim()) values.comfy_checkpoint = ckpt.value.trim();
        await api.post('/api/vault/integrations', { values });
        toast(t('wizard.saved')); void load();
      } catch (err) { toast(t('wizard.error', { message: errMsg(err) }), true); }
    };
    const test = async (): Promise<void> => {
      try {
        const r = await api.get<{ state: string }>('/api/vault/comfy-status');
        const ok = r.state === 'awake';
        showResult(out, ok, ok ? t('wizard.s4.ok') : t('wizard.s4.fail', { state: r.state }));
      } catch (err) { showResult(out, false, errMsg(err)); }
    };
    return stepShell('comfy', 4, t('wizard.s4.title'), false, state, t('wizard.s4.what'),
      instr(t('wizard.s4.instr')),
      field('wizard.s4.url', url), field('wizard.s4.ssh', ssh), field('wizard.s4.checkpoint', ckpt),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'primary', onclick: () => void save() }, t('wizard.save')), h('button', { onclick: () => void test() }, t('wizard.test')), out),
      h('div', { class: 'wiz-skiprow' }, skipBtn('comfy')),
    );
  }

  // ---- Finish ----
  function stepFinish(st: OnboardingStatus): HTMLElement {
    const authDone = st.steps.auth.done === true;
    const done = (label: string, ok: boolean | undefined): HTMLElement =>
      h('li', null, `${ok ? '✓' : '○'} ${label}`);
    const finish = async (): Promise<void> => {
      try { await api.post('/api/onboarding/complete', {}); toast(t('wizard.finish.done')); window.location.hash = '#overview'; }
      catch (err) { toast(t('wizard.error', { message: errMsg(err) }), true); }
    };
    return h('div', { class: 'wiz-finish' },
      h('div', { class: 'wiz-step-title' }, t('wizard.finish.title')),
      h('ul', { class: 'wiz-summary' },
        done(t('wizard.s1.title'), st.steps.auth.done),
        done(t('wizard.tg.title'), st.steps.telegram.configured),
        done(t('wizard.dc.title'), st.steps.discord.configured),
        done(t('wizard.s3.title'), st.steps.ollama.configured),
        done(t('wizard.s4.title'), st.steps.comfy.configured),
      ),
      h('div', { class: 'wiz-note' }, t('wizard.finish.restartNote')),
      h('button', { class: 'primary wiz-finishbtn', ...(authDone ? {} : { disabled: true }), 'data-finish': '1', onclick: () => void finish() }, authDone ? t('wizard.finish.btn') : t('wizard.finish.blocked')),
    );
  }
}

defineView('wizard', 'nav.wizard', render);
