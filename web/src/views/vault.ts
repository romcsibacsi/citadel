// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Vault view (PROMPT-16): the encrypted secret store. A header action cluster
 * (Bind / Scan & Import / Sync / New key), an encryption info banner, a 4-tile
 * stat strip, a guided system-integrations card, an inline add-secret panel, a
 * live search, and a metadata-only secrets grid (reveal/edit/delete per card).
 * Plus Bind + Scan modals. NO secret value ever enters the list model or a log;
 * plaintext is fetched one id at a time on an explicit Reveal/Edit only.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Secret { id: string; label: string; createdAt: string; updatedAt: string }
interface Binding { secretId: string; envVar: string; targets?: string[] }
interface Integration { key: string; label: string; description: string; secret: boolean; placeholder: string; set: boolean; preview: string | null }
interface Connector { name: string; scope: string; type: string }

/** update-source check errorKey -> i18n (shared with the Updates view copy). */
const UPD_ERR: Record<string, string> = {
  'no-repo': 'updates.err.noRepo',
  'no-host': 'updates.err.noHost',
  'no-branch-on-repo': 'updates.err.noBranchOnRepo',
  'head-not-on-repo': 'updates.err.headNotOnRepo',
  detached: 'updates.err.detached',
};
const UPD_PROVIDERS = ['github', 'gitea'];

let showAdd = false;
let searchQuery = '';
let comfyTimer: number | undefined;

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(currentLocale());
}
function makeModal(titleText: string, body: HTMLElement, cls = ''): { backdrop: HTMLElement; close: () => void } {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.append(h('div', { class: `modal ${cls}` },
    h('div', { class: 'agent-modal-titlebar' }, h('h2', null, titleText), h('button', { class: 'icon-btn', 'aria-label': t('vault.close'), onclick: close }, '✕')),
    body));
  document.body.append(backdrop); document.body.classList.add('modal-open');
  return { backdrop, close };
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  void store;
  if (comfyTimer !== undefined) { clearInterval(comfyTimer); comfyTimer = undefined; }
  const reload = (): void => void render(host, store);

  let secrets: Secret[] = [];
  let bindings: Binding[] = [];
  try {
    [secrets, bindings] = await Promise.all([
      api.get<Secret[]>('/api/vault'),
      api.get<Binding[]>('/api/vault/bindings'),
    ]);
  } catch { /* resilient: leave empties */ }
  const bindCount = (id: string): number => bindings.filter((b) => b.secretId === id).length;

  // ---------- Bind modal ----------
  const openBind = (): void => {
    const status = h('div', { class: 'bind-status', style: 'display:none' });
    const keySel = h('select', null) as HTMLSelectElement;
    const srvSel = h('select', null) as HTMLSelectElement;
    const envEl = h('input', { type: 'text', placeholder: t('vault.bind.envPh') }) as HTMLInputElement;
    const bindBtn = h('button', { class: 'primary' }, t('vault.bind.btn')) as HTMLButtonElement;
    const body = h('div', { class: 'agent-modal-body' },
      h('div', { class: 'field' }, h('label', null, t('vault.bind.key')), keySel),
      h('div', { class: 'field' }, h('label', null, t('vault.bind.server')), srvSel),
      h('div', { class: 'field' }, h('label', null, t('vault.bind.env')), envEl),
      status,
      h('div', { class: 'modal-actions' }, bindBtn),
    );
    const { close } = makeModal(t('vault.bind.title'), body, 'vault-bind-modal');
    if (secrets.length === 0) mount(keySel, h('option', { value: '', disabled: true }, t('vault.bind.noKey')));
    else mount(keySel, ...secrets.map((s) => h('option', { value: s.id }, s.label !== s.id ? `${s.id} (${s.label})` : s.id)));
    void api.get<Connector[]>('/api/connectors').then((conns) => {
      const eligible = conns.filter((c) => c.type !== 'plugin');
      if (eligible.length === 0) mount(srvSel, h('option', { value: '', disabled: true }, t('vault.bind.noServer')));
      else mount(srvSel, ...eligible.map((c) => h('option', { value: c.name }, c.scope !== 'user' ? `${c.name} (${c.scope})` : c.name)));
    }).catch(() => mount(srvSel, h('option', { value: '', disabled: true }, t('vault.bind.noServer'))));
    bindBtn.addEventListener('click', () => void (async () => {
      if (keySel.value === '' || srvSel.value === '' || envEl.value.trim() === '') { status.style.display = 'block'; status.className = 'bind-status err'; status.textContent = t('vault.error.allRequired'); return; }
      bindBtn.disabled = true; bindBtn.textContent = t('vault.bind.saving');
      try {
        const r = await api.post<{ synced: number }>('/api/vault/bindings', { vaultSecretId: keySel.value, serverName: srvSel.value, envVar: envEl.value.trim() });
        status.style.display = 'block'; status.className = 'bind-status ok'; status.textContent = t('vault.bind.success', { n: r.synced });
        setTimeout(() => { close(); reload(); }, 1500);
      } catch (err) { status.style.display = 'block'; status.className = 'bind-status err'; status.textContent = err instanceof ApiError ? err.message : t('vault.error.generic'); bindBtn.disabled = false; bindBtn.textContent = t('vault.bind.btn'); }
    })());
  };

  // ---------- Scan modal ----------
  interface Finding { serverName: string; envVar: string; maskedValue: string; suggestedVaultId: string; alreadyInVault: boolean; fileCount?: number }
  const openScan = async (scanBtn: HTMLButtonElement): Promise<void> => {
    scanBtn.disabled = true; scanBtn.textContent = t('vault.scanning');
    let findings: Finding[] = [];
    try { findings = (await api.get<{ findings: Finding[] }>('/api/vault/scan')).findings; } catch { /* */ }
    scanBtn.disabled = false; scanBtn.replaceChildren(icon('list', 16), document.createTextNode(t('vault.scan')));
    const actionable = findings.filter((f) => !f.alreadyInVault);
    const body = h('div', { class: 'agent-modal-body' }, h('p', { class: 'field-note' }, t('vault.scan.desc')));
    if (actionable.length === 0) {
      body.append(h('div', { class: 'muted-note scan-clean' }, findings.length > 0 ? t('vault.scan.allCovered', { n: findings.length }) : t('vault.scan.clean')));
      makeModal(t('vault.scan.title'), body, 'vault-scan-modal');
      return;
    }
    // each row carries its own checkbox + editable suggested vault id; Import
    // collects the checked rows into the real import request (server, envVar, id).
    const rows = actionable.map((f) => {
      const cb = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
      const idEl = h('input', { type: 'text', class: 'scan-id', value: f.suggestedVaultId }) as HTMLInputElement;
      const row = h('div', { class: 'scan-row' },
        cb,
        h('span', { class: 'scan-srv' }, f.serverName),
        h('span', { class: 'scan-env mono' }, `${f.envVar} = ${f.maskedValue}`),
        h('span', { class: 'muted-note' }, t('vault.scan.inFiles', { n: f.fileCount ?? 1 })),
        idEl,
      );
      return { f, cb, idEl, row };
    });
    body.append(h('div', { class: 'scan-rows' }, ...rows.map((r) => r.row)));
    const importBtn = h('button', { class: 'primary' }, t('vault.scan.import')) as HTMLButtonElement;
    body.append(h('div', { class: 'modal-actions' }, importBtn));
    const { close } = makeModal(t('vault.scan.title'), body, 'vault-scan-modal');
    importBtn.addEventListener('click', () => void (async () => {
      const imports = rows.filter((r) => r.cb.checked).map((r) => ({ serverName: r.f.serverName, envVar: r.f.envVar, vaultId: r.idEl.value.trim() || r.f.suggestedVaultId }));
      if (imports.length === 0) { toast(t('vault.import.nothing'), true); return; }
      importBtn.disabled = true; importBtn.textContent = t('vault.importing');
      try {
        const r = await api.post<{ imported: number; bound: number; errors: string[] }>('/api/vault/import', { imports });
        toast(t('vault.import.done', { imported: r.imported, bound: r.bound }));
        if (r.errors?.length) toast(t('vault.import.errors', { msg: r.errors.join('; ') }), true);
        close(); reload();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : t('vault.error.generic'), true);
        importBtn.disabled = false; importBtn.textContent = t('vault.scan.import');
      }
    })());
  };

  // ---------- secret card ----------
  const secretCard = (s: Secret): HTMLElement => {
    const n = bindCount(s.id);
    const valueBlock = h('div', { class: 'secret-value-block', style: 'display:none' });
    const editBlock = h('div', { class: 'secret-edit-block', style: 'display:none' });
    let revealed = false;
    const revealBtn = h('button', { class: 'btn-mini' }, icon('eye', 14), t('vault.card.reveal')) as HTMLButtonElement;
    const resetReveal = (): void => { revealed = false; valueBlock.style.display = 'none'; valueBlock.replaceChildren(); revealBtn.replaceChildren(icon('eye', 14), document.createTextNode(t('vault.card.reveal'))); };
    const toggleReveal = async (): Promise<void> => {
      editBlock.style.display = 'none'; editBlock.replaceChildren();
      if (revealed) { resetReveal(); return; }
      try {
        const r = await api.get<{ value: string }>(`/api/vault/${encodeURIComponent(s.id)}`);
        mount(valueBlock, h('pre', { class: 'secret-value mono' }, r.value));
        valueBlock.style.display = 'block'; revealed = true;
        revealBtn.replaceChildren(icon('eyeOff', 14), document.createTextNode(t('vault.card.hide')));
      } catch { /* fail closed */ }
    };
    revealBtn.addEventListener('click', () => void toggleReveal());
    const openEdit = async (): Promise<void> => {
      resetReveal();
      let current = '';
      try { current = (await api.get<{ value: string }>(`/api/vault/${encodeURIComponent(s.id)}`)).value; } catch { return; }
      const input = h('input', { type: 'password', value: current }) as HTMLInputElement;
      const closeEdit = (): void => { editBlock.style.display = 'none'; editBlock.replaceChildren(); };
      const save = async (): Promise<void> => {
        if (input.value === '') return;
        try { await api.post('/api/vault', { id: s.id, label: s.label, value: input.value }); toast(t('vault.toast.updated')); reload(); }
        catch (err) { toast(err instanceof ApiError ? err.message : t('vault.error.generic'), true); }
      };
      mount(editBlock, input, h('div', { class: 'edit-actions' }, h('button', { class: 'btn-mini', onclick: closeEdit }, t('vault.card.cancel')), h('button', { class: 'btn-mini primary', onclick: () => void save() }, t('vault.card.save'))));
      input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') closeEdit(); });
      editBlock.style.display = 'block'; setTimeout(() => { input.focus(); input.select(); }, 0);
    };
    const del = (): void => { if (!window.confirm(t('vault.card.deleteConfirm', { id: s.id }))) return; void api.delete(`/api/vault/${encodeURIComponent(s.id)}`).then(() => reload()).catch((err) => toast(err instanceof ApiError ? err.message : t('vault.error.generic'), true)); };
    return h('div', { class: 'secret-card' },
      h('div', { class: 'secret-head' }, h('span', { class: 'secret-lock' }, icon('lock', 16)),
        h('span', { class: 'secret-id' }, s.id),
        ...(n > 0 ? [h('span', { class: 'badge bind-badge', title: t('vault.card.bindBadge', { n }) }, t('vault.card.bindBadge', { n }))] : []),
      ),
      ...(s.label !== s.id ? [h('div', { class: 'secret-label muted-note' }, s.label)] : []),
      h('div', { class: 'secret-date muted-note' }, shortDate(s.updatedAt)),
      valueBlock, editBlock,
      h('div', { class: 'secret-actions' },
        revealBtn,
        h('button', { class: 'btn-mini', onclick: () => void openEdit() }, icon('pencil', 14), t('vault.card.edit')),
        h('button', { class: 'btn-mini danger', onclick: del }, icon('trash', 14), t('vault.card.delete')),
      ),
    );
  };

  // ---------- system integrations card ----------
  const integCard = h('div', { class: 'panel integ-card' });
  const buildInteg = (defs: Integration[]): void => {
    const inputs = new Map<string, HTMLInputElement>();
    const statusLine = h('div', { class: 'integ-status muted-note' });
    const comfyRow = h('div', { class: 'comfy-row' });
    // free-text inputs that also offer a live dropdown once "Load models" runs
    const ckptList = h('datalist', { id: 'integ-comfy-ckpts' });
    const ollamaList = h('datalist', { id: 'integ-ollama-models' });
    const testResults = new Map<string, HTMLElement>();

    // ComfyUI Test: reuse the existing reachability probe (+ version/device/models).
    const testComfy = async (): Promise<void> => {
      const r = testResults.get('comfy_url'); if (!r) return;
      r.className = 'integ-test-result muted-note'; r.textContent = t('vault.integ.testing');
      try {
        const cs = await api.get<{ state: string; version?: string; device?: string; models?: number }>('/api/vault/comfy-status');
        const detail = [cs.version ? `(${cs.version})` : '', cs.device ?? '', cs.models !== undefined ? t('vault.integ.modelsN', { n: cs.models }) : ''].filter((s) => s !== '').join(' · ');
        r.className = `integ-test-result ${cs.state === 'awake' ? 'ok' : 'err'}`;
        r.textContent = `${t(`vault.comfy.${cs.state}`)}${detail !== '' ? ` · ${detail}` : ''}`;
      } catch { r.className = 'integ-test-result err'; r.textContent = t('vault.error.generic'); }
    };
    // ollama Test: a tiny read-only /api/tags probe → reachable + model count.
    const testOllama = async (): Promise<void> => {
      const r = testResults.get('ollama_url'); if (!r) return;
      r.className = 'integ-test-result muted-note'; r.textContent = t('vault.integ.testing');
      try {
        const os = await api.get<{ state: string; models: number }>('/api/vault/ollama-status');
        const ok = os.state === 'reachable';
        r.className = `integ-test-result ${ok ? 'ok' : 'err'}`;
        r.textContent = ok
          ? t('vault.integ.ollamaReachable', { n: os.models })
          : os.state === 'unconfigured' ? t('vault.integ.ollamaUnconfigured') : t('vault.integ.ollamaUnreachable');
      } catch { r.className = 'integ-test-result err'; r.textContent = t('vault.error.generic'); }
    };
    // Load models: populate both datalists from the live servers (free-text stays).
    const loadModels = async (): Promise<void> => {
      statusLine.textContent = t('vault.integ.loadingModels');
      try {
        const [cm, om] = await Promise.all([
          api.get<{ reachable: boolean; models: string[] }>('/api/vault/comfy-models'),
          api.get<{ reachable: boolean; models: string[] }>('/api/vault/ollama-models'),
        ]);
        mount(ckptList, ...cm.models.map((m) => h('option', { value: m })));
        mount(ollamaList, ...om.models.map((m) => h('option', { value: m })));
        statusLine.textContent = (cm.reachable || om.reachable)
          ? t('vault.integ.modelsLoaded', { comfy: cm.models.length, ollama: om.models.length })
          : t('vault.integ.modelsUnreachable');
      } catch { statusLine.textContent = t('vault.integ.modelsUnreachable'); }
    };

    // Field wrappers by key, so the provider radiogroup can show/hide the Gitea host.
    const fieldEls = new Map<string, HTMLElement>();
    let providerValue = (defs.find((d) => d.key === 'update-provider')?.preview || 'github').trim() || 'github';
    const applyHostVisibility = (): void => {
      const hostField = fieldEls.get('update-host');
      if (hostField) hostField.style.display = providerValue === 'gitea' ? '' : 'none';
    };
    // "Test connection" for the update source: real read-only check, inline ok/err.
    const testUpdateSource = async (result: HTMLElement): Promise<void> => {
      result.className = 'integ-test-result muted-note'; result.textContent = '…';
      // Test-before-save: probe the ENTERED draft values (a blank token falls back
      // to the stored secret server-side); the draft test never mutates saved state.
      const draft = {
        provider: inputs.get('update-provider')?.value,
        repo: inputs.get('update-repo')?.value ?? '',
        branch: inputs.get('update-branch')?.value,
        host: inputs.get('update-host')?.value,
        token: inputs.get('update-token')?.value,
      };
      try {
        const r = await api.post<{ ok: boolean; message?: string; errorKey?: string }>('/api/vault/check-updates', draft);
        result.className = 'integ-test-result ' + (r.ok ? 'ok' : 'err');
        result.textContent = r.errorKey && UPD_ERR[r.errorKey] ? t(UPD_ERR[r.errorKey]!) : (r.message ?? t('vault.error.generic'));
      } catch { result.className = 'integ-test-result err'; result.textContent = t('vault.error.generic'); }
    };

    const fields = defs.map((d) => {
      const chip = d.set ? h('span', { class: 'badge on integ-chip' }, t('vault.integ.set')) : h('span', { class: 'badge muted integ-chip' }, t('vault.integ.notSet'));

      // Provider: a radiogroup (the one genuinely new control). Its value lives in a
      // hidden input registered in `inputs`, so the shared Save posts it like any
      // other integration value; selecting it toggles the Gitea host field.
      if (d.key === 'update-provider') {
        const hidden = h('input', { type: 'hidden', value: providerValue }) as HTMLInputElement;
        inputs.set(d.key, hidden);
        const opts = UPD_PROVIDERS.map((p) =>
          h('button', { type: 'button', class: 'integ-provider-opt' + (p === providerValue ? ' on' : ''), role: 'radio', 'aria-checked': String(p === providerValue) }, p) as HTMLButtonElement,
        );
        opts.forEach((b, i) => b.addEventListener('click', () => {
          providerValue = UPD_PROVIDERS[i]!;
          hidden.value = providerValue;
          opts.forEach((x, j) => { const on = j === i; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
          applyHostVisibility();
        }));
        const wrap = h('div', { class: 'field integ-field' },
          h('label', null, d.label, ' ', chip),
          h('div', { class: 'integ-provider', role: 'radiogroup', 'aria-label': d.label }, ...opts),
          hidden,
          h('div', { class: 'field-note' }, d.description),
        );
        fieldEls.set(d.key, wrap);
        return wrap;
      }

      // the two model fields become a free-text input wired to a live datalist (pick OR type)
      const listAttr = d.key === 'comfy_checkpoint' ? { list: 'integ-comfy-ckpts' } : d.key === 'ollama_model' ? { list: 'integ-ollama-models' } : {};
      const input = h('input', { type: d.secret ? 'password' : 'text', autocomplete: 'off', value: d.secret ? '' : (d.preview ?? ''), placeholder: d.secret && d.set ? t('vault.integ.keepBlank') : d.placeholder, ...listAttr }) as HTMLInputElement;
      inputs.set(d.key, input);
      const extras: HTMLElement[] = [];
      if (d.key === 'comfy_url' || d.key === 'ollama_url') {
        const result = h('span', { class: 'integ-test-result muted-note' });
        testResults.set(d.key, result);
        // data-integ-test keys the row so tests target it by anchor, not DOM position
        extras.push(h('div', { class: 'integ-test-row', 'data-integ-test': d.key },
          h('button', { class: 'btn-mini', onclick: () => void (d.key === 'comfy_url' ? testComfy() : testOllama()) }, t('vault.integ.test')),
          result));
      }
      if (d.key === 'update-repo') {
        const result = h('span', { class: 'integ-test-result muted-note' });
        extras.push(h('div', { class: 'integ-test-row', 'data-integ-test': 'update-repo' },
          h('button', { class: 'btn-mini', onclick: () => void testUpdateSource(result) }, t('vault.integ.test')),
          result));
      }
      const wrap = h('div', { class: 'field integ-field' },
        h('label', null, d.label, ' ', chip, ...(!d.secret && d.preview ? [h('span', { class: 'integ-preview mono' }, d.preview)] : [])),
        input,
        h('div', { class: 'field-note' }, d.description),
        ...extras,
      );
      fieldEls.set(d.key, wrap);
      return wrap;
    });
    applyHostVisibility();
    const save = async (): Promise<void> => {
      const values: Record<string, string> = {};
      for (const [k, el] of inputs) values[k] = el.value;
      try { const r = await api.post<{ saved: number }>('/api/vault/integrations', { values }); statusLine.textContent = t('vault.integ.saved', { n: r.saved }); reload(); }
      catch (err) { statusLine.textContent = t('vault.integ.error', { msg: err instanceof ApiError ? err.message : '' }); }
    };
    const checkUpdates = async (): Promise<void> => {
      try { const r = await api.post<{ message: string }>('/api/vault/check-updates'); statusLine.textContent = r.message; }
      catch (err) { statusLine.textContent = err instanceof ApiError ? err.message : t('vault.error.generic'); }
    };
    mount(integCard,
      h('div', { class: 'panel-title' }, t('vault.integ.title')),
      h('div', { class: 'field-note integ-sub' }, t('vault.integ.sub')),
      h('div', { class: 'info-box integ-connect-help' }, t('vault.integ.connectHelp')),
      ckptList, ollamaList,
      ...fields,
      h('div', { class: 'modal-actions integ-actions' },
        h('button', { class: 'primary', onclick: () => void save() }, t('vault.integ.save')),
        h('button', { class: 'secondary', onclick: () => void loadModels() }, t('vault.integ.loadModels')),
        h('button', { class: 'secondary', title: t('vault.integ.checkTip'), onclick: () => void checkUpdates() }, t('vault.integ.check')),
      ),
      statusLine,
      comfyRow,
    );
    const pollComfy = (): void => { void api.get<{ state: string; text: string; wakeable: boolean }>('/api/vault/comfy-status').then((cs) => {
      const dotCls = cs.state === 'awake' ? 'dot-connected' : cs.state === 'asleep' ? 'dot-degraded' : cs.state === 'unreachable' ? 'dot-failed' : 'dot-unknown';
      const stateText = t(`vault.comfy.${cs.state}`);
      mount(comfyRow, h('span', { class: `conn-dot ${dotCls}` }), h('span', { class: 'comfy-text' }, `ComfyUI: ${stateText}${cs.text ? ` · ${cs.text}` : ''}`),
        ...(cs.wakeable ? [h('button', { class: 'btn-mini', onclick: () => void api.post('/api/vault/comfy-wake').then(() => toast(t('vault.comfy.waking'))).catch(() => undefined) }, t('vault.integ.wake'))] : []));
    }).catch(() => undefined); };
    pollComfy();
    if (comfyTimer !== undefined) clearInterval(comfyTimer);
    comfyTimer = window.setInterval(() => { if (integCard.isConnected) pollComfy(); else if (comfyTimer !== undefined) clearInterval(comfyTimer); }, 20_000);
  };
  void api.get<Integration[]>('/api/vault/integrations').then(buildInteg).catch(() => undefined);

  // ---------- add-secret inline panel ----------
  const addPanel = h('div', { class: 'add-secret-panel', style: showAdd ? '' : 'display:none' });
  const buildAdd = (): void => {
    const idEl = h('input', { type: 'text', placeholder: t('vault.add.idPh') }) as HTMLInputElement;
    const descEl = h('input', { type: 'text', placeholder: t('vault.add.descPh') }) as HTMLInputElement;
    const valEl = h('input', { type: 'password', placeholder: 'sk-...' }) as HTMLInputElement;
    const save = async (): Promise<void> => {
      if (idEl.value.trim() === '' || valEl.value === '') return;
      try { await api.post('/api/vault', { id: idEl.value.trim(), label: descEl.value.trim() || idEl.value.trim(), value: valEl.value }); showAdd = false; toast(t('vault.toast.updated')); reload(); }
      catch (err) { toast(err instanceof ApiError ? err.message : t('vault.error.generic'), true); }
    };
    valEl.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void save(); });
    mount(addPanel,
      h('div', { class: 'add-panel-head' }, h('b', null, t('vault.add.title')), h('button', { class: 'icon-btn', onclick: () => { showAdd = false; addPanel.style.display = 'none'; } }, '✕')),
      h('div', { class: 'field' }, h('label', null, t('vault.add.id')), idEl),
      h('div', { class: 'field' }, h('label', null, t('vault.add.desc')), descEl),
      h('div', { class: 'field' }, h('label', null, t('vault.add.value')), valEl),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: () => void save() }, icon('lock', 14), t('vault.add.save'))),
    );
    if (showAdd) setTimeout(() => idEl.focus(), 0);
  };
  buildAdd();

  // ---------- secrets grid + search ----------
  const grid = h('div', { class: 'secrets-grid' });
  const renderGrid = (): void => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q === '' ? secrets : secrets.filter((s) => s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q));
    if (secrets.length === 0) { mount(grid, h('div', { class: 'empty-block vault-empty' }, icon('lock', 40), h('div', { class: 'muted-note' }, t('vault.empty.title')), h('div', { class: 'field-note' }, t('vault.empty.hint')))); return; }
    mount(grid, ...filtered.map(secretCard));
  };

  const scanBtn = h('button', { class: 'secondary', title: t('vault.scanTip') }, icon('list', 16), t('vault.scan')) as HTMLButtonElement;
  scanBtn.addEventListener('click', () => void openScan(scanBtn));
  const syncBtn = h('button', { class: 'secondary', title: t('vault.syncTip') }, icon('refresh', 16), t('vault.sync')) as HTMLButtonElement;
  syncBtn.addEventListener('click', () => void (async () => {
    syncBtn.disabled = true; syncBtn.replaceChildren(document.createTextNode(t('vault.syncing')));
    try { const r = await api.post<{ updated: number }>('/api/vault/sync'); toast(r.updated > 0 ? t('vault.sync.done', { n: r.updated }) : t('vault.sync.nothing')); }
    catch (err) { toast(err instanceof ApiError ? err.message : t('vault.error.generic'), true); }
    reload();
  })());

  mount(host,
    h('div', { class: 'page-header vault-header' },
      h('div', null, h('h1', null, t('vault.title')), h('p', { class: 'subtitle' }, t('vault.subtitle'))),
      h('div', { class: 'vault-actions' },
        h('button', { class: 'secondary', title: t('vault.bindTip'), onclick: openBind }, icon('plug', 16), t('vault.bindBtn')),
        scanBtn, syncBtn,
        h('button', { class: 'primary', onclick: () => { showAdd = !showAdd; addPanel.style.display = showAdd ? '' : 'none'; if (showAdd) buildAdd(); } }, icon('plus', 16), t('vault.newKey')),
      ),
    ),
    h('div', { class: 'info-box' }, t('vault.infoBanner')),
    h('div', { class: 'stat-row vault-stats' },
      h('div', { class: 'stat-card' }, h('div', { class: 'stat-value' }, String(secrets.length)), h('div', { class: 'stat-label' }, t('vault.stat.keys'))),
      h('div', { class: 'stat-card' }, h('div', { class: 'stat-value' }, 'AES-256'), h('div', { class: 'stat-label' }, t('vault.stat.encryption'))),
      h('div', { class: 'stat-card' }, h('div', { class: 'stat-value' }, String(bindings.length)), h('div', { class: 'stat-label' }, t('vault.stat.bindings'))),
      h('div', { class: 'stat-card' }, h('div', { class: 'stat-value' }, t('vault.stat.localValue')), h('div', { class: 'stat-label' }, t('vault.stat.storage'))),
    ),
    integCard,
    addPanel,
    h('div', { class: 'vault-search' }, icon('list', 16), h('input', { type: 'text', placeholder: t('vault.searchPh'), value: searchQuery, oninput: (e: Event) => { searchQuery = (e.target as HTMLInputElement).value; renderGrid(); } })),
    grid,
  );
  renderGrid();
}

defineView('vault', 'nav.vault', (host, store) => { void render(host, store); });
