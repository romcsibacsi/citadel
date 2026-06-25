// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { importSkillDir, isUnsafeRelativePath } from '../../skills/importer.js';
import type { SkillScope } from '../../skills/store.js';

function scopeOf(raw: string | undefined): SkillScope {
  if (raw === 'global' || raw === 'local') return raw;
  throw new HttpError(400, 'scope must be global or local');
}

export function registerSkillRoutes(router: Router, ctx: AppContext): void {
  // Scope-filterable list (FIX-skills-view-filter): no params → global (back-compat);
  // ?scope=local&agent=<id> → that agent's local skills (with agentId attached so the
  // detail reader can resolve the right shadow). Each item carries a docPresent flag.
  router.get('/api/skills', (c) => {
    const scope = c.url.searchParams.get('scope');
    if (scope === 'local') {
      const agent = sanitizeId(c.url.searchParams.get('agent') ?? '');
      if (agent === '') throw new HttpError(400, 'agent required for local scope');
      sendJson(c.res, 200, ctx.skills.listLocal(agent).map((m) => ({ ...m, agentId: agent })));
      return;
    }
    sendJson(c.res, 200, ctx.skills.listGlobal());
  });

  // Real per-scope counts for the library stat strip (FIX-10 §1): global (fleet),
  // agent-local (summed across the roster), and documented globals — never a card
  // that just repeats Total.
  router.get('/api/skills/stats', ({ res }) => {
    const globals = ctx.skills.listGlobal();
    let local = 0;
    for (const a of ctx.config.agents) {
      const id = sanitizeId(a.id);
      if (id === '') continue; // a malformed id has no local root to scan
      local += ctx.skills.listLocal(id).length;
    }
    sendJson(res, 200, {
      global: globals.length,
      local,
      documented: globals.filter((s) => (s.description ?? '').trim() !== '').length,
    });
  });

  router.get('/api/skills/agent/:id', (c) => {
    sendJson(c.res, 200, ctx.skills.effectiveSkills(sanitizeId(c.params.id ?? '')));
  });

  router.get('/api/skills/read/:scope/:name', (c) => {
    const agent = c.url.searchParams.get('agent');
    // scope=global reads through the hub's view (its root IS the global root),
    // which bypasses any local shadow; scope=local resolves shadow-first.
    const viewAs =
      c.params.scope === 'global' ? ctx.config.hubId : agent !== null ? sanitizeId(agent) : ctx.config.hubId;
    const doc = ctx.skills.readSkill(c.params.name ?? '', viewAs);
    if (!doc) throw new HttpError(404, 'no such skill');
    sendJson(c.res, 200, doc);
  });

  /**
   * Governance (SPEC §10): global needs hub approval. The operator outranks
   * the hub, so a dashboard create carries implicit approval; an agent token
   * only passes for its OWN local scope — global creation by a non-hub agent
   * is rejected by the store (approvedByHub=false).
   */
  router.post('/api/skills', (c) => {
    const body = (c.body ?? {}) as {
      scope?: string;
      agentId?: string;
      name?: string;
      description?: string;
      body?: string;
    };
    const scope = scopeOf(body.scope);
    if (!body.name || !body.description || !body.body) throw new HttpError(400, 'name, description, body required');
    let agentId: string | null;
    let approvedByHub: boolean;
    if (c.auth.kind === 'agent') {
      agentId = sanitizeId(c.auth.agentId);
      approvedByHub = agentId === sanitizeId(ctx.config.hubId);
      if (scope === 'local' && body.agentId !== undefined && sanitizeId(body.agentId) !== agentId) {
        throw new HttpError(403, 'agents may only manage their own local skills');
      }
    } else {
      agentId = body.agentId !== undefined ? sanitizeId(body.agentId) : null;
      approvedByHub = true; // operator action
    }
    try {
      sendJson(c.res, 201, ctx.skills.createSkill(scope, agentId, body.name, body.description, body.body, { approvedByHub }));
    } catch (err) {
      throw new HttpError(403, err instanceof Error ? err.message : 'skill creation rejected');
    }
  });

  router.delete('/api/skills/:scope/:name', (c) => {
    requireOperator(c);
    const scope = scopeOf(c.params.scope);
    const agent = c.url.searchParams.get('agent');
    try {
      ctx.skills.deleteSkill(scope, agent !== null ? sanitizeId(agent) : null, c.params.name ?? '', {
        approvedByHub: true,
      });
    } catch (err) {
      throw new HttpError(403, err instanceof Error ? err.message : 'delete rejected');
    }
    sendJson(c.res, 200, { deleted: c.params.name });
  });

  /** Import from a host directory — traversal/symlink/overwrite-safe (SPEC §10). */
  router.post('/api/skills/import', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { scope?: string; agentId?: string; sourceDir?: string };
    const scope = scopeOf(body.scope);
    if (typeof body.sourceDir !== 'string' || body.sourceDir === '') throw new HttpError(400, 'sourceDir required');
    try {
      sendJson(
        c.res,
        201,
        importSkillDir(
          {
            globalRoot: ctx.paths.skillsGlobalDir,
            agentRoot: (id) => `${ctx.paths.agentsDir}/${sanitizeId(id)}/skills`,
            hubId: ctx.config.hubId,
          },
          scope,
          body.agentId !== undefined ? sanitizeId(body.agentId) : null,
          body.sourceDir,
          { approvedByHub: true },
        ),
      );
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'import rejected');
    }
  });

  // Drag/drop import (FIX-03 §6): the client drops a skill folder; its files
  // arrive as {rel, content} (JSON — no multipart parser in the zero-dep stack).
  // We materialize them into a fresh temp dir and reuse the HARDENED importSkillDir
  // (traversal/symlink/SKILL.md validation), so this path is no less safe than the
  // host-dir import. Binary .zip/.tar.gz archives are deferred (no zip parser).
  router.post('/api/skills/import-files', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { scope?: string; agentId?: string; files?: Array<{ rel?: string; content?: string }> };
    const scope = scopeOf(body.scope);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) throw new HttpError(400, 'files required');
    const tmp = mkdtempSync(join(tmpdir(), 'skill-import-'));
    try {
      for (const f of files) {
        const rel = (f.rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (rel === '' || isUnsafeRelativePath(rel)) throw new HttpError(400, `unsafe path: ${f.rel ?? ''}`);
        if (typeof f.content !== 'string') throw new HttpError(400, `missing content: ${rel}`);
        const dest = join(tmp, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.content, { mode: 0o600 });
      }
      sendJson(
        c.res,
        201,
        importSkillDir(
          {
            globalRoot: ctx.paths.skillsGlobalDir,
            agentRoot: (id) => `${ctx.paths.agentsDir}/${sanitizeId(id)}/skills`,
            hubId: ctx.config.hubId,
          },
          scope,
          body.agentId !== undefined ? sanitizeId(body.agentId) : null,
          tmp,
          { approvedByHub: true },
        ),
      );
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err instanceof Error ? err.message : 'import rejected');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
