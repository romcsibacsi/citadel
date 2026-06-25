// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { join, delimiter, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import type { Router, RouteContext } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { agentPaths } from '../../app/scaffold.js';
import { listMcpServerNames } from '../../vault/configScan.js';
import { ConnectorError, type AddConnectorInput } from '../../connectors/service.js';
import type { ConnectorRecord } from '../../connectors/store.js';
import { assertPublicUrl, parseAllowlist, SsrfError } from '../../tools/ssrf.js';

/**
 * MCP connector routes (PROMPT-13). Operator-only management surface: the
 * configured list + live-cache status, the shipped catalog (install/uninstall),
 * custom connectors (add/detail/assign/delete), and the Tools plumbing (github
 * repos, external paths).
 */

const ERROR_KEY: Record<ConnectorError['code'], string> = {
  name_required: 'connectors.error.nameRequired',
  url_required: 'connectors.error.urlRequired',
  command_required: 'connectors.error.commandRequired',
  not_found: 'connectors.error.notFound',
  invalid_path: 'connectors.error.invalidPath',
};

function connectorWire(c: ConnectorRecord): Record<string, unknown> {
  return {
    name: c.name,
    status: c.status,
    endpoint: c.endpoint,
    type: c.type,
    source: c.source,
    scope: c.scope,
    agentId: c.agentId,
    enabled: c.enabled,
  };
}

/**
 * Does the (stdio) command's first token resolve on PATH (or as an absolute/
 * relative file)? A pure existence check — NEVER executes the command (no RCE).
 */
function commandResolves(cmd: string): boolean {
  if (cmd === '') return false;
  if (isAbsolute(cmd) || cmd.startsWith('./') || cmd.startsWith('../')) return existsSync(cmd);
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).some((d) => existsSync(join(d, cmd)));
}

export function registerConnectorRoutes(router: Router, ctx: AppContext): void {
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ConnectorError) throw new HttpError(err.httpStatus, ctx.i18n.t(ERROR_KEY[err.code]));
      throw err;
    }
  };
  const op = (c: RouteContext): void => requireOperator(c);

  // The agent config files whose declared mcpServers mark a catalog entry as
  // already-installed (FIX-13 §3): each roster agent's project `.mcp.json` +
  // Claude Code `.claude.json`. Mirrors the vault scan's file set.
  const configServerNames = (): Set<string> => {
    const files: string[] = [];
    for (const a of ctx.config.agents) {
      const ap = agentPaths(ctx.paths, sanitizeId(a.id));
      files.push(join(ap.workDir, '.mcp.json'), join(ap.configRoot, '.claude.json'));
    }
    return listMcpServerNames(files);
  };

  // --- configured list + status + refresh ---
  router.get('/api/connectors', (c) => {
    op(c);
    sendJson(c.res, 200, ctx.connectors.list().map(connectorWire));
  });
  router.get('/api/connectors/status', (c) => {
    op(c);
    sendJson(c.res, 200, ctx.connectors.status());
  });
  router.post('/api/connectors/refresh', (c) => {
    op(c);
    sendJson(c.res, 200, ctx.connectors.refresh());
  });

  // Reachability/resolve probe (FIX-connectors-custom-mcp). Tests the form values
  // BEFORE saving; NEVER receives or sends secret env values. Remote = a bounded
  // HTTP GET (a 2xx/401/405 means the endpoint answered); stdio = the command's
  // first token resolves on PATH (existence only, never executed). Declared before
  // the dynamic :name routes so the static segment wins.
  router.post('/api/connectors/test', async (c) => {
    op(c);
    const body = (c.body ?? {}) as { type?: string; url?: string; command?: string };
    const remote = body.type === 'http' || body.type === 'sse' || body.type === 'remote';
    if (remote) {
      const url = (body.url ?? '').trim();
      if (!/^https?:\/\/\S+$/i.test(url)) { sendJson(c.res, 200, { ok: false, state: 'invalid' }); return; }
      // SSRF guard (FIX-hardening B): refuse a probe at an internal address
      // (loopback / RFC1918 / 169.254.169.254 / *.local / DNS-resolves-to-private)
      // BEFORE any fetch — this is an operator-driven server-side GET, a confused-
      // deputy/rebinding surface. The operator's browse_ssrf_allow setting can still
      // deliberately exempt an internal box. Reuses ssrf.ts (no re-implementation).
      try {
        await assertPublicUrl(url, { allowHosts: parseAllowlist(ctx.settings.get('browse_ssrf_allow')) });
      } catch (err) {
        if (err instanceof SsrfError) { sendJson(c.res, 200, { ok: false, state: 'refused' }); return; }
        throw err;
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      try {
        const res = await fetch(url, { method: 'GET', signal: ctl.signal });
        // an auth-gated or method-restricted endpoint still proves reachability
        sendJson(c.res, 200, { ok: res.ok || res.status === 401 || res.status === 403 || res.status === 405, state: 'reachable', status: res.status });
      } catch (err) {
        const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
        const refused = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND';
        sendJson(c.res, 200, { ok: false, state: refused ? 'unreachable' : 'unknown' });
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    const first = (body.command ?? '').trim().split(/\s+/)[0] ?? '';
    if (first === '') { sendJson(c.res, 200, { ok: false, state: 'invalid' }); return; }
    const ok = commandResolves(first);
    sendJson(c.res, 200, { ok, state: ok ? 'resolved' : 'not_found', command: first });
  });

  // --- catalog ---
  router.get('/api/mcp-catalog', (c) => {
    op(c);
    sendJson(c.res, 200, ctx.connectors.catalog(configServerNames()));
  });
  router.post('/api/mcp-catalog/:id/install', (c) => {
    op(c);
    const env = ((c.body ?? {}) as { env?: Record<string, string> }).env ?? {};
    guard(() => sendJson(c.res, 200, ctx.connectors.installFromCatalog(c.params.id ?? '', env)));
  });
  router.delete('/api/mcp-catalog/:id/uninstall', (c) => {
    op(c);
    guard(() => sendJson(c.res, 200, ctx.connectors.uninstallFromCatalog(c.params.id ?? '')));
  });

  // --- github repos (declared before :name so the static segment wins) ---
  router.get('/api/connectors/github-repos', (c) => {
    op(c);
    sendJson(c.res, 200, ctx.connectors.listRepos());
  });
  router.post('/api/connectors/github-repos', (c) => {
    op(c);
    const url = ((c.body ?? {}) as { url?: string }).url ?? '';
    guard(() => sendJson(c.res, 201, ctx.connectors.installRepo(url)));
  });
  router.patch('/api/connectors/github-repos/:name', (c) => {
    op(c);
    guard(() => sendJson(c.res, 200, ctx.connectors.updateRepo(decodeURIComponent(c.params.name ?? ''))));
  });
  router.delete('/api/connectors/github-repos/:name', (c) => {
    op(c);
    guard(() => sendJson(c.res, 200, ctx.connectors.deleteRepo(decodeURIComponent(c.params.name ?? ''))));
  });

  // --- external paths ---
  router.get('/api/connectors/external-paths', (c) => {
    op(c);
    sendJson(c.res, 200, ctx.connectors.listPaths());
  });
  router.post('/api/connectors/external-paths', (c) => {
    op(c);
    const path = ((c.body ?? {}) as { path?: string }).path ?? '';
    guard(() => sendJson(c.res, 201, ctx.connectors.addPath(path)));
  });
  router.delete('/api/connectors/external-paths', (c) => {
    op(c);
    const path = ((c.body ?? {}) as { path?: string }).path ?? '';
    guard(() => sendJson(c.res, 200, ctx.connectors.deletePath(path)));
  });

  // --- custom connectors ---
  router.post('/api/connectors', (c) => {
    op(c);
    guard(() => sendJson(c.res, 201, ctx.connectors.addConnector((c.body ?? {}) as AddConnectorInput)));
  });
  router.get('/api/connectors/:name', (c) => {
    op(c);
    const name = decodeURIComponent(c.params.name ?? '');
    guard(() => sendJson(c.res, 200, { ...ctx.connectors.detail(name), assignedAgents: ctx.connectors.assignedAgents(name) }));
  });
  router.post('/api/connectors/:name/assign', (c) => {
    op(c);
    const body = (c.body ?? {}) as { agents?: string[]; allAgents?: string[] };
    guard(() => sendJson(c.res, 200, ctx.connectors.assign(decodeURIComponent(c.params.name ?? ''), body.agents ?? [], body.allAgents ?? [])));
  });
  router.patch('/api/connectors/:name/enabled', (c) => {
    op(c);
    const raw = ((c.body ?? {}) as { enabled?: unknown }).enabled;
    if (typeof raw !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
    guard(() => sendJson(c.res, 200, ctx.connectors.setEnabled(decodeURIComponent(c.params.name ?? ''), raw)));
  });
  router.delete('/api/connectors/:name', (c) => {
    op(c);
    guard(() => sendJson(c.res, 200, ctx.connectors.deleteConnector(decodeURIComponent(c.params.name ?? ''))));
  });
}
