// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { join } from 'node:path';
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { agentPaths, repoRoot } from '../../app/scaffold.js';
import { encodeTarget, decodeTarget } from '../../vault/store.js';
import { suggestVaultId } from '../../vault/secretHeuristics.js';
import { scanConfigFiles, findServerTargets, rewriteEnvToRef, stripEnvVar, type ScanFinding } from '../../vault/configScan.js';
import { normalizeProvider, normalizeRepo, buildCommitsRequest } from '../../updates/deps.js';
import { RemoteCheckError } from '../../updates/service.js';

/**
 * Best-effort enrichment of a reachable ComfyUI (PROMPT-19 §6.10/§10, FIX-19 §4):
 * version + device from /system_stats, model count from the checkpoint loader's
 * available list. Every probe is short-timeout and failure-tolerant — a backend
 * that answers the base URL but not these endpoints simply reports awake with no
 * extra detail. Never throws.
 */
async function probeComfyInfo(base: string): Promise<{ version?: string; device?: string; models?: number }> {
  const out: { version?: string; device?: string; models?: number } = {};
  const getJson = async (path: string): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}${path}`, { signal: controller.signal });
      if (!res.ok) return undefined;
      return await res.json();
    } catch { return undefined; } finally { clearTimeout(timer); }
  };
  const stats = await getJson('/system_stats') as { system?: { comfyui_version?: string }; devices?: Array<{ name?: string }> } | undefined;
  if (stats !== undefined) {
    const v = stats.system?.comfyui_version;
    if (typeof v === 'string' && v !== '') out.version = v;
    const d = stats.devices?.[0]?.name;
    if (typeof d === 'string' && d !== '') out.device = d;
  }
  // checkpoint count: prefer the object_info node shape, fall back to /models/checkpoints
  const ckpt = await getJson('/object_info/CheckpointLoaderSimple') as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } } } | undefined;
  const names = ckpt?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (Array.isArray(names)) out.models = names.length;
  else {
    const list = await getJson('/models/checkpoints');
    if (Array.isArray(list)) out.models = list.length;
  }
  return out;
}

/** A bearer-gated, short-timeout, never-throw JSON GET of an operator-configured
 * endpoint (FIX-integrations-connect). Only http(s) URLs are dialed. */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(u.trim());
}
async function fetchJson(rawUrl: string, path: string, timeoutMs = 2500): Promise<unknown | null> {
  const base = rawUrl.trim().replace(/\/+$/, '');
  if (!isHttpUrl(base)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}
/** ComfyUI checkpoint names, or null when the server is unreachable (→ free-text fallback). */
async function comfyCheckpointNames(base: string): Promise<string[] | null> {
  const j = await fetchJson(base, '/object_info/CheckpointLoaderSimple') as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } } } | null;
  if (j === null) return null;
  const names = j.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}
/** ComfyUI LoRA names (LoraLoader.lora_name), or null when unreachable (FIX-plugin-comfy-workflows §6). */
async function comfyLoraNames(base: string): Promise<string[] | null> {
  const j = await fetchJson(base, '/object_info/LoraLoader') as { LoraLoader?: { input?: { required?: { lora_name?: unknown[] } } } } | null;
  if (j === null) return null;
  const names = j.LoraLoader?.input?.required?.lora_name?.[0];
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}
/** ollama model names from /api/tags, or null when unreachable. */
async function ollamaModelNames(base: string): Promise<string[] | null> {
  const j = await fetchJson(base, '/api/tags') as { models?: Array<{ name?: unknown }> } | null;
  if (j === null) return null;
  return (j.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
}

/** Guided system-integration settings (PROMPT-16 §5B). Secrets go to the vault. */
interface IntegrationSetting { key: string; labelKey: string; descKey: string; secret: boolean; placeholder: string }
const INTEGRATIONS: IntegrationSetting[] = [
  { key: 'update-provider', labelKey: 'vault.integ.updateProvider', descKey: 'vault.integ.updateProviderDesc', secret: false, placeholder: 'github | gitea' },
  { key: 'update-repo', labelKey: 'vault.integ.updateRepo', descKey: 'vault.integ.updateRepoDesc', secret: false, placeholder: 'owner/repo' },
  { key: 'update-branch', labelKey: 'vault.integ.updateBranch', descKey: 'vault.integ.updateBranchDesc', secret: false, placeholder: '(empty = running branch)' },
  { key: 'update-host', labelKey: 'vault.integ.updateHost', descKey: 'vault.integ.updateHostDesc', secret: false, placeholder: 'https://gitea.example.com' },
  { key: 'update-token', labelKey: 'vault.integ.updateToken', descKey: 'vault.integ.updateTokenDesc', secret: true, placeholder: 'ghp_...' },
  { key: 'comfy_url', labelKey: 'vault.integ.comfyUrl', descKey: 'vault.integ.comfyUrlDesc', secret: false, placeholder: 'http://comfyui-host:8188' },
  { key: 'comfy_checkpoint', labelKey: 'vault.integ.comfyModel', descKey: 'vault.integ.comfyModelDesc', secret: false, placeholder: 'sd_xl_base_1.0.safetensors' },
  { key: 'comfy_ssh', labelKey: 'vault.integ.wakeHost', descKey: 'vault.integ.wakeHostDesc', secret: false, placeholder: 'user@host[:port]' },
  { key: 'comfy_wake_cmd', labelKey: 'vault.integ.wakeCmd', descKey: 'vault.integ.wakeCmdDesc', secret: false, placeholder: 'bash ~/comfyui-wake.sh' },
  { key: 'ollama_model', labelKey: 'vault.integ.ollamaModel', descKey: 'vault.integ.ollamaModelDesc', secret: false, placeholder: 'qwen2.5:7b' },
  { key: 'ollama_url', labelKey: 'vault.integ.ollamaUrl', descKey: 'vault.integ.ollamaUrlDesc', secret: false, placeholder: 'http://localhost:11434' },
  { key: 'embedding_model', labelKey: 'vault.integ.embeddingModel', descKey: 'vault.integ.embeddingModelDesc', secret: false, placeholder: 'nomic-embed-text' },
  { key: 'browse_allowlist', labelKey: 'vault.integ.browseAllowlist', descKey: 'vault.integ.browseAllowlistDesc', secret: false, placeholder: 'example.com, docs.example.org' },
  { key: 'browse_ssrf_allow', labelKey: 'vault.integ.browseSsrf', descKey: 'vault.integ.browseSsrfDesc', secret: false, placeholder: '(leave empty)' },
  { key: 'diagram_renderer_cmd', labelKey: 'vault.integ.diagramCmd', descKey: 'vault.integ.diagramCmdDesc', secret: false, placeholder: 'mmdc -i {in} -o {out}' },
  { key: 'whisper_url', labelKey: 'vault.integ.whisperUrl', descKey: 'vault.integ.whisperUrlDesc', secret: false, placeholder: 'http://whisper-host:9000' },
  { key: 'whisper_cmd', labelKey: 'vault.integ.whisperCmd', descKey: 'vault.integ.whisperCmdDesc', secret: false, placeholder: 'whisper {in} --output_format txt' },
];

/**
 * Vault API discipline (SPEC §16): list returns metadata ONLY; a single-id GET
 * is the one value-returning read; everything operator-gated.
 */
export function registerVaultRoutes(router: Router, ctx: AppContext): void {
  const bindingsFor = (id: string): number => ctx.vault.listBindings(id).length;

  // The MCP config files the scan/sync mechanism walks: each roster agent's
  // project `.mcp.json` + Claude Code `.claude.json` (mcpServers live there).
  const configFiles = (): string[] => {
    const files: string[] = [];
    for (const a of ctx.config.agents) {
      const ap = agentPaths(ctx.paths, sanitizeId(a.id));
      files.push(join(ap.workDir, '.mcp.json'), join(ap.configRoot, '.claude.json'));
    }
    return files;
  };
  // Absolute path to the launch wrapper that resolves vault: refs at MCP spawn.
  const wrapperPath = join(repoRoot(), 'scripts', 'vault-exec');
  // id -> plaintext, for the scan's alreadyInVault match (operator-gated read).
  const knownSecrets = (): Map<string, string> => {
    const m = new Map<string, string>();
    for (const meta of ctx.vault.listMetadata()) {
      const v = ctx.vault.getSecretValue(meta.id);
      if (v !== undefined) m.set(meta.id, v);
    }
    return m;
  };

  // Add/overwrite a secret (preserves createdAt in the store), then report how
  // many bindings would re-sync. POST is the spec's create surface.
  router.post('/api/vault', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { id?: string; label?: string; value?: string };
    const id = (body.id ?? '').trim();
    if (id === '' || typeof body.value !== 'string' || body.value === '') throw new HttpError(400, ctx.i18n.t('vault.error.idValueRequired'));
    ctx.vault.setSecret(id, body.label && body.label.trim() !== '' ? body.label : id, body.value);
    sendJson(c.res, 200, { ok: true, synced: bindingsFor(id) });
  });

  // Re-apply every binding to its target file: ensure the bound env var equals
  // its `vault:<id>` reference and the launch command is wrapped (idempotent).
  // `updated` counts file targets re-affirmed; legacy/global bindings (no file)
  // are counted too so an intent recorded before its server existed still shows.
  router.post('/api/vault/sync', (c) => {
    requireOperator(c);
    let updated = 0;
    const errors: string[] = [];
    for (const b of ctx.vault.listBindings()) {
      const decoded = decodeTarget(b.target);
      if (decoded === null) {
        updated += 1; // legacy/global recorded intent — nothing to rewrite
        continue;
      }
      try {
        const r = rewriteEnvToRef(decoded.filePath, decoded.serverName, b.envVar, b.secretId, wrapperPath, { create: true });
        if (r.present) updated += 1;
      } catch {
        errors.push(`${b.secretId}/${b.envVar}`);
      }
    }
    sendJson(c.res, 200, { ok: true, updated, errors });
  });

  // Scan every agent's MCP config files for plaintext leaks: env entries whose
  // key name looks sensitive AND whose value looks like a real secret. The full
  // value NEVER leaves the server — only a mask + a suggested vault id (§6/§8).
  router.get('/api/vault/scan', (c) => {
    requireOperator(c);
    const findings = scanConfigFiles(configFiles(), knownSecrets()).map((f) => ({
      mcpFilePath: f.fileTargets[0],
      serverName: f.serverName,
      envVar: f.envVar,
      maskedValue: f.maskedValue,
      suggestedVaultId: f.suggestedVaultId,
      alreadyInVault: f.alreadyInVault,
      ...(f.existingVaultId !== undefined ? { existingVaultId: f.existingVaultId } : {}),
      fileCount: f.fileCount,
    }));
    sendJson(c.res, 200, { findings });
  });

  // Import selected leaks: for each {serverName, envVar, vaultId}, re-scan to read
  // the real plaintext out of its config file(s), store it encrypted under the
  // chosen id, bind it, and rewrite each file to the `vault:<id>` reference (+ wrap
  // the launch command). The client only ever sends ids/names — never a value.
  router.post('/api/vault/import', (c) => {
    requireOperator(c);
    const imports = ((c.body ?? {}) as { imports?: Array<{ serverName?: string; envVar?: string; vaultId?: string; mcpFilePath?: string }> }).imports ?? [];
    const findings = scanConfigFiles(configFiles(), knownSecrets());
    let imported = 0;
    let bound = 0;
    const errors: string[] = [];
    for (const imp of imports) {
      const serverName = (imp.serverName ?? '').trim();
      const envVar = (imp.envVar ?? '').trim();
      if (serverName === '' || envVar === '') { errors.push('serverName and envVar required'); continue; }
      const vaultId = (imp.vaultId ?? '').trim() !== '' ? (imp.vaultId ?? '').trim() : suggestVaultId(serverName, envVar);
      // disambiguate by the file the client picked: two files can share a
      // (serverName, envVar) with DIFFERENT values, which scan splits into
      // distinct findings — match the right one by its file target, not just the pair.
      const mcpFilePath = (imp.mcpFilePath ?? '').trim();
      const finding: ScanFinding | undefined = findings.find(
        (f) => f.serverName === serverName && f.envVar === envVar && (mcpFilePath === '' || f.fileTargets.includes(mcpFilePath)),
      );
      if (finding === undefined) { errors.push(`${serverName}/${envVar}: not found`); continue; }
      try {
        ctx.vault.setSecret(vaultId, `${envVar} (${serverName})`, finding.value);
        imported += 1;
        // rewrite the file FIRST; only record the binding once the ref is in place
        // (so a failed rewrite never leaves a binding pointing at un-rewritten plaintext).
        for (const file of finding.fileTargets) {
          const r = rewriteEnvToRef(file, serverName, envVar, vaultId, wrapperPath);
          if (r.present) {
            ctx.vault.bind(vaultId, envVar, encodeTarget(file, serverName));
            bound += 1;
          }
        }
      } catch (err) {
        errors.push(`${serverName}/${envVar}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    sendJson(c.res, 200, { ok: true, imported, bound, errors });
  });

  // Guided integrations: set/not-set state (+ non-secret previews).
  router.get('/api/vault/integrations', (c) => {
    requireOperator(c);
    const secretIds = new Set(ctx.vault.listMetadata().map((s) => s.id));
    sendJson(c.res, 200, INTEGRATIONS.map((s) => {
      const value = s.secret ? undefined : ctx.settings.get(s.key);
      return {
        key: s.key, label: ctx.i18n.t(s.labelKey), description: ctx.i18n.t(s.descKey), secret: s.secret, placeholder: s.placeholder,
        set: s.secret ? secretIds.has(s.key) : (value ?? '') !== '',
        preview: s.secret ? null : (value ?? ''),
      };
    }));
  });

  router.post('/api/vault/integrations', (c) => {
    requireOperator(c);
    const values = ((c.body ?? {}) as { values?: Record<string, string> }).values ?? {};
    let saved = 0;
    for (const s of INTEGRATIONS) {
      if (!(s.key in values)) continue;
      const v = String(values[s.key] ?? '');
      if (s.secret) {
        if (v.trim() !== '') { ctx.vault.setSecret(s.key, s.key, v); saved += 1; } // blank = keep
      } else {
        if (v.trim() === '') ctx.settings.delete(s.key); else ctx.settings.set(s.key, v);
        saved += 1;
      }
    }
    sendJson(c.res, 200, { ok: true, saved });
  });

  // Image backend (ComfyUI) live status — a best-effort reachability probe
  // (FIX-16 §4 + PROMPT-19 §6.10/§10):
  //   no url            -> unconfigured (no Wake)
  //   2xx               -> awake        (+ version/device/model-count, FIX-19 §4)
  //   503               -> asleep       (Wake offered when a wake host is set)
  //   other HTTP status -> unreachable  (server answered but not serving)
  //   connection refused-> unreachable  (definitively down → "stopped")
  //   timeout/DNS/other -> unknown      (probe couldn't determine — FIX-19 §3)
  router.get('/api/vault/comfy-status', async (c) => {
    requireOperator(c);
    const url = ctx.settings.get('comfy_url') ?? ctx.settings.get('comfy-url');
    const wakeHost = ctx.settings.get('comfy_ssh') ?? ctx.settings.get('comfy-wake-host');
    const canWake = wakeHost !== undefined && wakeHost !== '';
    if (url === undefined || url === '') { sendJson(c.res, 200, { state: 'unconfigured', text: '', wakeable: false }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const info = await probeComfyInfo(url);
        // surface the ACTIVE checkpoint (explicit setting → first available) so the
        // operator can see what will render — a photoreal checkpoint can't do cartoon
        // and won't know IP characters (FIX-studio-brain §C).
        const explicit = (ctx.settings.get('comfy_checkpoint') ?? ctx.settings.get('comfy-model') ?? '').trim();
        let checkpoint = explicit !== '' ? explicit : undefined;
        if (checkpoint === undefined) { const names = await comfyCheckpointNames(url); if (names !== null && names.length > 0) checkpoint = names[0]; }
        sendJson(c.res, 200, { state: 'awake', text: url, wakeable: false, ...info, ...(checkpoint !== undefined ? { checkpoint } : {}) });
        return;
      }
      const state = res.status === 503 ? 'asleep' : 'unreachable';
      sendJson(c.res, 200, { state, text: url, wakeable: canWake });
    } catch (err) {
      // a refused connection is a definitive "down" (stopped); a timeout / DNS
      // failure / unexpected error means we genuinely could not determine it (unknown).
      const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
      const refused = code === 'ECONNREFUSED' || code === 'ECONNRESET';
      sendJson(c.res, 200, { state: refused ? 'unreachable' : 'unknown', text: url, wakeable: canWake });
    } finally {
      clearTimeout(timer);
    }
  });

  router.post('/api/vault/comfy-wake', (c) => {
    requireOperator(c);
    const sshTarget = ctx.settings.get('comfy_ssh') ?? ctx.settings.get('comfy-wake-host');
    sendJson(c.res, 200, { ok: sshTarget !== undefined && sshTarget !== '' });
  });

  // Live checkpoint list for the comfy_checkpoint picker (FIX-integrations-connect §2).
  // reachable:false → the UI keeps the free-text input. Read-only, short-timeout.
  router.get('/api/vault/comfy-models', async (c) => {
    requireOperator(c);
    const url = ctx.settings.get('comfy_url') ?? ctx.settings.get('comfy-url');
    if (url === undefined || url === '') { sendJson(c.res, 200, { reachable: false, models: [] }); return; }
    const names = await comfyCheckpointNames(url);
    sendJson(c.res, 200, { reachable: names !== null, models: names ?? [] });
  });

  // Live ComfyUI LoRA list for the Studio LoRA dropdown (FIX-plugin-comfy-workflows §6),
  // mirroring comfy-models: unset/unreachable → reachable:false (free-text fallback).
  router.get('/api/vault/comfy-loras', async (c) => {
    requireOperator(c);
    const url = ctx.settings.get('comfy_url') ?? ctx.settings.get('comfy-url');
    if (url === undefined || url === '') { sendJson(c.res, 200, { reachable: false, loras: [] }); return; }
    const names = await comfyLoraNames(url);
    sendJson(c.res, 200, { reachable: names !== null, loras: names ?? [] });
  });

  // Live ollama model list for the ollama_model picker (FIX-integrations-connect §2).
  // When ollama_url is unset, report unconfigured (reachable:false) like comfy-models —
  // an unconfigured buyer instance must NOT silently dial localhost (FIX-cleanup-round2 §D).
  router.get('/api/vault/ollama-models', async (c) => {
    requireOperator(c);
    const url = ctx.settings.get('ollama_url');
    if (url === undefined || url === '') { sendJson(c.res, 200, { reachable: false, models: [] }); return; }
    const names = await ollamaModelNames(url);
    sendJson(c.res, 200, { reachable: names !== null, models: names ?? [] });
  });

  // ollama reachability Test button (FIX-integrations-connect §1): reachable + model count.
  router.get('/api/vault/ollama-status', async (c) => {
    requireOperator(c);
    const url = ctx.settings.get('ollama_url');
    if (url === undefined || url === '') { sendJson(c.res, 200, { state: 'unconfigured', models: 0, text: '' }); return; }
    const names = await ollamaModelNames(url);
    sendJson(c.res, 200, names !== null ? { state: 'reachable', models: names.length, text: url } : { state: 'unreachable', models: 0, text: url });
  });

  // "Test connection" for the update-source integration: runs a REAL read-only
  // check against the saved provider/repo/host/token (no value echoed) and
  // reports reachability + behind-count or a stable errorKey the UI localizes.
  router.post('/api/vault/check-updates', async (c) => {
    requireOperator(c);
    const b = (c.body ?? {}) as { provider?: string; repo?: string; branch?: string; host?: string; token?: string };
    // Draft test (test-before-save): if the panel sent entered values, probe THOSE
    // with a one-off read-only request — do NOT forceCheck, so the saved-config
    // status cache stays intact. A blank token falls back to the stored secret.
    if (typeof b.repo === 'string' && b.repo.trim() !== '') {
      const repo = normalizeRepo(b.repo);
      if (repo === null) {
        sendJson(c.res, 200, { ok: false, errorKey: 'no-repo' });
        return;
      }
      const provider = normalizeProvider(b.provider);
      const branch = (b.branch ?? '').trim() || ctx.updates.status()?.branch || 'main';
      const token =
        typeof b.token === 'string' && b.token.trim() !== '' ? b.token.trim() : ctx.vault.getSecretValue('update-token');
      try {
        const { url, headers } = buildCommitsRequest(provider, repo, branch, token, b.host?.trim());
        const res = await fetch(url, { headers });
        if (res.status === 404) {
          sendJson(c.res, 200, { ok: false, errorKey: 'no-branch-on-repo' });
          return;
        }
        if (!res.ok) {
          sendJson(c.res, 200, { ok: false, errorKey: 'generic', status: res.status });
          return;
        }
        const data = (await res.json()) as Array<{ sha?: string }>;
        const latest = data[0]?.sha ?? '';
        sendJson(c.res, 200, { ok: true, latestShort: latest.slice(0, 7), message: ctx.i18n.t('vault.update.checked', { repo }) });
      } catch (err) {
        sendJson(c.res, 200, { ok: false, errorKey: err instanceof RemoteCheckError ? err.key : 'generic' });
      }
      return;
    }
    // No draft values: check the saved config (also refreshes the Updates cache).
    const repo = ctx.settings.get('update-repo');
    if (!repo) {
      sendJson(c.res, 200, { ok: false, message: ctx.i18n.t('vault.update.noRepo') });
      return;
    }
    const status = await ctx.updates.forceCheck();
    if (status.error) {
      sendJson(c.res, 200, { ok: false, errorKey: status.errorKey, message: status.error });
      return;
    }
    sendJson(c.res, 200, {
      ok: true,
      behind: status.behind,
      currentShort: status.currentShort,
      latestShort: status.latestShort,
      message: ctx.i18n.t('vault.update.checked', { repo }),
    });
  });

  router.get('/api/vault', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, ctx.vault.listMetadata());
  });

  router.get('/api/vault/bindings', (c) => {
    requireOperator(c);
    const secretId = c.url.searchParams.get('secret');
    sendJson(c.res, 200, ctx.vault.listBindings(secretId ?? undefined));
  });

  router.get('/api/vault/:id', (c) => {
    requireOperator(c);
    const value = ctx.vault.getSecretValue(c.params.id ?? '');
    if (value === undefined) throw new HttpError(404, 'no such secret');
    sendJson(c.res, 200, { id: c.params.id, value });
  });

  router.put('/api/vault/:id', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { label?: string; value?: string };
    if (typeof body.value !== 'string' || body.value === '') throw new HttpError(400, 'value required');
    ctx.vault.setSecret(c.params.id ?? '', body.label ?? c.params.id ?? '', body.value);
    sendJson(c.res, 200, { stored: c.params.id });
  });

  // Delete cascades (SPEC §6): drop the encrypted secret + its bindings (FK), and
  // strip the secret's env var out of every config file it was wired into (and
  // unwrap the launch command where no vault: refs remain) so no dangling
  // `vault:<id>` reference is left to fail a future launch.
  router.delete('/api/vault/:id', (c) => {
    requireOperator(c);
    const id = c.params.id ?? '';
    const bindings = ctx.vault.listBindings(id);
    if (!ctx.vault.deleteSecret(id)) throw new HttpError(404, 'no such secret');
    for (const b of bindings) {
      const decoded = decodeTarget(b.target);
      if (decoded === null) continue;
      try {
        stripEnvVar(decoded.filePath, decoded.serverName, b.envVar, wrapperPath);
      } catch {
        /* best-effort cleanup — the secret + binding are already gone */
      }
    }
    sendJson(c.res, 200, { deleted: id });
  });

  // Bind a secret to a server's env var (SPEC §6 bind flow): resolve which config
  // files declare that server, record one binding per file target, and sync each
  // (set env var -> vault:<id> + wrap the launch command). 400 when no file
  // declares the server (nothing to bind into). A bind with no server name records
  // a global intent (legacy target) that a later sync/import can attach to a file.
  router.post('/api/vault/bindings', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { secretId?: string; vaultSecretId?: string; envVar?: string; target?: string; serverName?: string };
    const secretId = body.secretId ?? body.vaultSecretId ?? '';
    const serverName = body.serverName ?? body.target ?? '';
    if (secretId === '' || !body.envVar) throw new HttpError(400, ctx.i18n.t('vault.error.allRequired'));
    const envVar = body.envVar;
    if (ctx.vault.getSecretValue(secretId) === undefined) throw new HttpError(404, 'no such secret');
    try {
      if (serverName === '') {
        ctx.vault.bind(secretId, envVar, '');
        sendJson(c.res, 201, { ok: true, bound: secretId, synced: 0 });
        return;
      }
      const targets = findServerTargets(configFiles(), serverName);
      if (targets.length === 0) throw new HttpError(400, ctx.i18n.t('vault.error.noTargets'));
      let synced = 0;
      for (const file of targets) {
        // rewrite first; record the binding only once the ref is in place
        const r = rewriteEnvToRef(file, serverName, envVar, secretId, wrapperPath, { create: true });
        if (r.present) {
          ctx.vault.bind(secretId, envVar, encodeTarget(file, serverName));
          synced += 1;
        }
      }
      sendJson(c.res, 201, { ok: true, bound: secretId, synced });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err instanceof Error ? err.message : 'binding rejected');
    }
  });

  router.delete('/api/vault/bindings', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { secretId?: string; envVar?: string; target?: string };
    if (!body.secretId || !body.envVar) throw new HttpError(400, 'secretId and envVar required');
    if (!ctx.vault.unbind(body.secretId, body.envVar, body.target ?? '')) throw new HttpError(404, 'no such binding');
    sendJson(c.res, 200, { unbound: body.secretId });
  });
}
