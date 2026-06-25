// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, readFileSync, readdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig, OrchestratorConfig, StatePaths } from '../config/types.js';
import { ensureDir, writeIfAbsent, createExclusive, readTextIfExists, atomicWriteFile } from '../core/fsx.js';
import { newToken } from '../core/ids.js';
import { sanitizeId } from '../trust/sanitize.js';
import { resolveRulePlaceholders, effectivePermissionMode } from '../security/permission.js';
import { createLogger } from '../core/log.js';

const log = createLogger('scaffold');

/** Repo root (seed templates live there, not in the state dir). */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function seedDir(): string {
  return join(repoRoot(), 'seed');
}

const PROSE_NAMES: Record<string, string> = { hu: 'magyar (Hungarian)', en: 'English' };

export interface AgentPaths {
  root: string;
  workDir: string;
  configRoot: string;
  skillsDir: string;
  tokenFile: string;
  sessionMarker: string;
}

export function agentPaths(paths: StatePaths, agentId: string): AgentPaths {
  const root = join(paths.agentsDir, sanitizeId(agentId));
  return {
    root,
    workDir: join(root, 'workdir'),
    configRoot: join(root, 'config-root'),
    skillsDir: join(root, 'skills'),
    tokenFile: join(root, 'agent-token'),
    sessionMarker: join(root, '.session-started'),
  };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Z_]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

function loadSeedText(relPath: string): string | undefined {
  const path = join(seedDir(), relPath);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Compact agent-facing tool guide (English protocol text, recorded assumption). */
function toolsDoc(agent: AgentConfig, config: OrchestratorConfig, serverUrl: string): string {
  return `
## Orchestrator tools

You are agent \`${sanitizeId(agent.id)}\` in ${config.branding.productName}. The orchestrator API is at ${serverUrl}
(your scoped token file is $AGENT_TOKEN_FILE; the \`agentctl\` command wraps it):

- \`agentctl msg send <agent|operator> <text>\` — send a message (peers: questions/status only; work returns to the hub)
- \`agentctl kanban add <title> [--desc "..."] [--assignee <id>] [--priority low|normal|high|urgent]\` — create a card
- \`agentctl msg done <id> [result]\` / \`agentctl msg fail <id> <error>\` — close out a delivered message
- \`agentctl mem save <hot|warm|cold|shared> <text> [--keywords "..."]\` — durable memory (shared = fleet-visible)
- \`agentctl mem search <query>\` — recall (your tiers + shared)
- \`agentctl kanban board\` / \`agentctl kanban move <id> <status>\` / \`agentctl kanban comment <id> <text>\`
- \`agentctl idea add <title> [--desc "..."]\` — drop an idea into the idea box
- \`agentctl log <line>\` — append to your daily activity log
- \`agentctl state save\` — persist task state (JSON on stdin) before compaction/restart
- \`agentctl dream write\` (hub only) — overwrite the nightly consolidation file (markdown on stdin)
- \`agentctl dream read\` — read it

## Git — your own isolated worktree

You have a DEDICATED git worktree at \`$AGENT_REPO\` (branch \`agent/${sanitizeId(agent.id)}\`),
with its own HEAD/index over the shared object store. Do ALL git work THERE:

- \`cd "$AGENT_REPO"\` FIRST, then create your task branch and commit. NEVER run
  git in the shared/canonical checkout — every agent shares it, so your checkout,
  commits and merges would collide with theirs (stale reads, detached HEAD, lost work).
- Writing to \`main\` is gated: it goes through the release lane with operator
  approval. NEVER fast-forward or merge your own work into \`main\` yourself.

Messages arrive wrapped in security frames; the preamble explains each frame's trust level.
Write operator-facing prose in ${PROSE_NAMES[config.locale.agentProse] ?? config.locale.agentProse}.
`;
}

/**
 * Map an orchestrator permission defaultMode onto the Claude Code settings.json
 * `permissions.defaultMode` value.
 */
const CLAUDE_DEFAULT_MODE_MAP: Record<string, string> = {
  ask: 'default',
  deny: 'default',
  allow: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
};

/**
 * Claude Code settings.json for strict profiles (the runtime enforces the lists).
 * The effective defaultMode honors the global permission posture
 * (FIX-agent-permissions-permissive): under the 'permissive' default a cautious
 * 'ask' profile becomes bypassPermissions — NO interactive Bash prompt (so a
 * dispatched sub-agent never wedges) — while the deny list is ALWAYS preserved
 * (Claude enforces deny even in bypassPermissions: deny > defaultMode). When the
 * effective mode is bypassPermissions the `ask` list is cleared, because an `ask`
 * rule outranks defaultMode and would otherwise re-introduce the very prompt we
 * are removing. Permissive-mode profiles still get no settings.json (they launch
 * with --dangerously-skip-permissions).
 */
function strictSettings(agent: AgentConfig, config: OrchestratorConfig, agentDir: string): string | undefined {
  const profile = config.securityProfiles.find((p) => p.id === agent.securityProfile);
  if (!profile || profile.mode !== 'strict') return undefined;
  const vars = { AGENT_DIR: agentDir };
  const posture = config.defaultPermissionMode ?? 'permissive';
  const effective = effectivePermissionMode(profile, posture);
  const bypass = effective === 'bypassPermissions';
  const settings = {
    permissions: {
      allow: resolveRulePlaceholders(profile.allow, vars),
      ask: bypass ? [] : resolveRulePlaceholders(profile.ask, vars),
      deny: resolveRulePlaceholders(profile.deny, vars),
      ...(effective !== undefined ? { defaultMode: CLAUDE_DEFAULT_MODE_MAP[effective] ?? 'default' } : {}),
    },
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

export interface ScaffoldDeps {
  config: OrchestratorConfig;
  paths: StatePaths;
  serverUrl: string;
}

/** Template vars shared by the persona, operating doc, and CLAUDE.md renders. */
function buildVars(deps: ScaffoldDeps, agent: AgentConfig, locale: string): Record<string, string> {
  const hub = deps.config.agents.find((a) => sanitizeId(a.id) === sanitizeId(deps.config.hubId));
  const peers = deps.config.agents
    .filter((a) => a.hidden !== true && sanitizeId(a.id) !== sanitizeId(agent.id))
    .map((a) => `- ${a.displayName} (\`${sanitizeId(a.id)}\`) — ${a.role}`)
    .join('\n');
  return {
    AGENT_NAME: agent.displayName,
    AGENT_ROLE: agent.role,
    AGENT_SCOPE: agent.role,
    PRODUCT_NAME: deps.config.branding.productName,
    HUB_NAME: hub?.displayName ?? deps.config.hubId,
    PEER_LIST: peers,
    IRREVERSIBLE_EXAMPLES:
      locale === 'hu'
        ? 'publikálás, fizetés, adattörlés, külső üzenet, jogosultság-változtatás'
        : 'publishing, payments, data deletion, external messages, permission changes',
    PROSE_LANGUAGE: PROSE_NAMES[locale] ?? locale,
  };
}

interface RenderedDocs { persona: string; operating?: string; claude: string }

/**
 * The desired per-agent docs from the CURRENT seed (persona.md, operating.md, and
 * the combined CLAUDE.md the agent actually loads). Single source of truth for
 * both scaffoldAgent (writeIfAbsent) and reseedAgentDocs (overwrite-if-stub).
 */
function renderAgentDocs(deps: ScaffoldDeps, agent: AgentConfig): RenderedDocs {
  const isHub = sanitizeId(agent.id) === sanitizeId(deps.config.hubId);
  const locale = deps.config.locale.agentProse;
  const persona =
    loadSeedText(join('personas', locale, `${sanitizeId(agent.id)}.md`)) ??
    loadSeedText(join('personas', 'en', `${sanitizeId(agent.id)}.md`)) ??
    `# ${agent.displayName} — ${agent.role}\n`;
  // The operator's OWN per-agent operating doc (seed/operating/<id>.md — already
  // carries the shared §15 contract) ALWAYS wins, hub or not (FIX-nexus-operating:
  // the hub had its own operating doc silently dropped). Only the GENERIC subordinate
  // contract fallback is hub-omitted (the hub is never a subordinate).
  const ownOperating = loadSeedText(join('operating', `${sanitizeId(agent.id)}.md`));
  const contractTemplate = ownOperating
    ?? (isHub
      ? undefined
      : (loadSeedText(join('operating-contract', `${locale}.md`))
        ?? loadSeedText(join('operating-contract', 'en.md'))));
  const vars = buildVars(deps, agent, locale);
  const personaDoc = renderTemplate(persona, vars);
  const operatingDoc = contractTemplate !== undefined ? renderTemplate(contractTemplate, vars) : undefined;
  const operatingPart = operatingDoc !== undefined ? { operating: operatingDoc } : {};
  // CLAUDE.md is composed through the SINGLE shared composer so the boot/scaffold/reseed
  // writers render IDENTICALLY to the agent-card edit path — INCLUDING the cs.autoReply
  // addendum (#236). It previously lived ONLY in composeAgentClaude (the edit path), so the
  // runtime-written workdir/CLAUDE.md never carried it despite the config flags (#251 LIVE
  // canary). Output is byte-identical to the old join for every non-addendum agent.
  const claude = composeAgentClaude(deps, agent, { persona: personaDoc, ...operatingPart });
  return { persona: personaDoc, ...operatingPart, claude };
}

/**
 * Compose the workdir CLAUDE.md the agent actually loads from a (possibly
 * operator-edited) persona + operating doc + the live tools guide. Single shared
 * format so an edit through the agent card re-renders CLAUDE.md identically to the
 * scaffold (FIX-agent-card-persona). An empty operating doc is simply omitted.
 */
export function composeAgentClaude(deps: ScaffoldDeps, agent: AgentConfig, parts: { persona: string; operating?: string }): string {
  const segments = [parts.persona];
  if (parts.operating !== undefined && parts.operating.trim() !== '') segments.push(parts.operating);
  segments.push(toolsDoc(agent, deps.config, deps.serverUrl));
  // CS auto-reply mode (#236): a per-instance, DEMO-only override of the gated CS reply
  // flow. ONLY when config.cs.autoReply is on AND this is the customer-facing agent — the
  // main fleet (flag absent/false) keeps the gated draft+approval (support.md A2) untouched.
  // Instruct-level (the store still records every out; an enforce-level gate is a later step).
  if (deps.config.cs?.autoReply === true && agent.customerFacing === true) {
    segments.push(csAutoReplyAddendum(deps.config.locale.agentProse));
  }
  return segments.join('\n\n');
}

/** The DEMO-tenant CS auto-reply override appended to the customer-facing agent's CLAUDE.md (#236). */
function csAutoReplyAddendum(locale: string): string {
  if (locale === 'en') {
    return (
      '## CS REPLY MODE: AUTO (demo tenant)\n\n' +
      'On this instance CS auto-reply is ON (config.cs.autoReply=true). For a PLAIN customer ' +
      'reply (the CS-INBOUND draft) you do NOT gate: after composing the draft you send it ' +
      'IMMEDIATELY — POST .../interactions {direction:"out"} (the outbound worker delivers it in ' +
      'real time). Send the reply on the SAME channel as the inbound (an email inbound → channel:"email"; ' +
      'a web-widget inbound → channel:"widget") so the customer receives it the way they wrote in. ' +
      'Do NOT raise a requiresApproval card and do NOT wait for operator approval for ' +
      'a plain reply. The cs_* store is the LOG/AUDIT: every outgoing reply is recorded (direction:out).\n\n' +
      'IMPORTANT — the gate relaxes ONLY for a plain customer reply. Still APPROVAL-REQUIRED (never ' +
      'autonomous): money operations (refund/credit/compensation/purchase, `payment`) and customer-' +
      'DATA deletion (`data_delete`). Every other rule is unchanged (customer-data isolation, no expert ' +
      'advice as fact, the untrusted-inbound trust-frame).'
    );
  }
  return (
    '## CS-VÁLASZ MÓD: AUTO (demo-tenant)\n\n' +
    'Ezen az instance-on a CS auto-reply BE van kapcsolva (config.cs.autoReply=true). A SIMA ' +
    'ügyfél-választ (a CS-INBOUND draftját) NEM gated-eled: a draft elkészítése után AZONNAL ' +
    'küldöd — POST .../interactions {direction:"out"} (a kimenő worker valós időben küldi). A választ az ' +
    'inbound CSATORNÁJÁN küldd (email-inbound → channel:"email"; web-widget-inbound → channel:"widget"), ' +
    'hogy az ügyfél ott kapja meg, ahol írt. NEM ' +
    'veszel fel requiresApproval-kártyát és NEM vársz operátor-jóváhagyásra a sima válaszhoz. A ' +
    'cs_*-store a NAPLÓ/AUDIT: minden kimenő válasz rögzül (direction:out).\n\n' +
    'FONTOS — a gate CSAK a sima ügyfél-válaszra lazul. VÁLTOZATLANUL JÓVÁHAGYÁS-KÖTELES (soha ' +
    'autonóm): pénz-művelet (visszatérítés/jóváírás/kártérítés/beszerzés, `payment`) és ügyfél-ADAT ' +
    'törlése (`data_delete`). Minden más szabály változatlan (ügyfél-adat izoláció, nincs szakértői ' +
    'tanács tényként, untrusted-inbound trust-frame).'
  );
}

/**
 * Idempotent per-agent scaffolding (SPEC §4, §20.10): creates anything absent,
 * NEVER overwrites an existing file — operator edits and deletions of doc
 * CONTENT are respected (a deleted doc is re-filled only because absence is
 * indistinguishable from never-created; operators customize by editing).
 */
export function scaffoldAgent(deps: ScaffoldDeps, agentId: string): void {
  const agent = deps.config.agents.find((a) => sanitizeId(a.id) === sanitizeId(agentId));
  if (!agent) throw new Error(`cannot scaffold unknown agent: ${agentId}`);
  const ap = agentPaths(deps.paths, agent.id);
  const isHub = sanitizeId(agent.id) === sanitizeId(deps.config.hubId);

  ensureDir(ap.root, 0o700);
  ensureDir(ap.workDir, 0o700);
  ensureDir(ap.configRoot, 0o700);
  if (!isHub) ensureDir(ap.skillsDir, 0o700); // the hub's skill root IS the global root

  if (!existsSync(ap.tokenFile)) {
    createExclusive(ap.tokenFile, newToken(32), 0o600);
  }

  const docs = renderAgentDocs(deps, agent);
  writeIfAbsent(join(ap.workDir, 'CLAUDE.md'), docs.claude, 0o600);

  // persona + operating doc ALSO as standalone per-agent files (SPEC §4 persona model)
  writeIfAbsent(join(ap.root, 'persona.md'), docs.persona, 0o600);
  if (docs.operating !== undefined) {
    writeIfAbsent(join(ap.root, 'operating.md'), docs.operating, 0o600);
  }

  const settings = strictSettings(agent, deps.config, ap.root);
  if (settings !== undefined) {
    const wrote = writeIfAbsent(join(ap.configRoot, 'settings.json'), settings, 0o600);
    // Record provenance ON FIRST WRITE so a later profile change (e.g. an added
    // deny rule) is reliably re-applied by reseedAgentSettings via the hash-match
    // path — not misread as an operator edit (review fold-in). Only when WE created
    // it: never stamp over a pre-existing (possibly operator-edited) file.
    if (wrote) recordSettingsProvenance(ap.root, settings);
  }
}

/** Stamp the settings.json hash into the agent's provenance manifest (merge). */
function recordSettingsProvenance(agentRoot: string, settings: string): void {
  try {
    const manifestPath = join(agentRoot, SEED_PROVENANCE_FILE);
    const manifest = readProvenance(manifestPath);
    manifest['settings.json'] = sha256(settings);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  } catch (err) {
    log.warn('failed to record settings provenance', { agentRoot, error: String(err) });
  }
}

/** Scaffold every roster agent; safe to run at every boot. */
export function scaffoldAll(deps: ScaffoldDeps): void {
  for (const agent of deps.config.agents) {
    try {
      scaffoldAgent(deps, agent.id);
    } catch (err) {
      log.error(`scaffolding failed for ${agent.id}`, { error: String(err) });
    }
  }
}

/** Per-agent provenance of seeded docs (sha256 of each file WE wrote). */
const SEED_PROVENANCE_FILE = '.seed-provenance.json';
/**
 * Distinctive lines from the generic operating-CONTRACT template (hu + en). A doc
 * containing one is the auto-generated contract stub (the real per-agent operating
 * doc heads with the agent's own name and never carries these), so it is safe to
 * re-seed; an operator's real doc never matches.
 */
const CONTRACT_SENTINELS = ['ne szerkeszd ügynökönként', 'do not edit it per-agent'];

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function readProvenance(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export interface ReseedResult { changed: string[]; preserved: string[] }

/**
 * DELIBERATE re-seed of the per-agent docs onto the CURRENT real seed
 * (FIX-personas-apply) — distinct from the idempotent writeIfAbsent scaffold.
 * It OVERWRITES persona.md / operating.md / CLAUDE.md, but ONLY when the existing
 * file is still the unmodified auto-generated artifact; a genuine operator edit is
 * always preserved. "Unmodified generated" is recognized three ways (any suffices):
 *   1. its hash is recorded in the agent's .seed-provenance.json (we wrote it,
 *      byte-unchanged since),
 *   2. it already equals the desired seed render (nothing to do; record provenance),
 *   3. it matches a reproducible generated stub — persona.md === the rendered LEGACY
 *      stub persona (those templates use only the stable PRODUCT_NAME / PROSE_LANGUAGE
 *      vars), or operating.md / CLAUDE.md contains a generic-contract sentinel.
 * Returns the agents whose docs changed (caller restarts them so a live Claude Code
 * session re-reads its operating doc — adoption alone keeps the stale one).
 */
export function reseedAgentDocs(deps: ScaffoldDeps): ReseedResult {
  const changed = new Set<string>();
  const preserved: string[] = [];
  const locale = deps.config.locale.agentProse;
  for (const agent of deps.config.agents) {
    try {
      const ap = agentPaths(deps.paths, agent.id);
      if (!existsSync(ap.root)) continue; // never scaffolded — scaffoldAgent owns first-write
      const docs = renderAgentDocs(deps, agent);
      const vars = buildVars(deps, agent, locale);
      const legacyPersona =
        loadSeedText(join('legacy-personas', locale, `${sanitizeId(agent.id)}.md`)) ??
        loadSeedText(join('legacy-personas', 'en', `${sanitizeId(agent.id)}.md`));
      const legacyPersonaRendered = legacyPersona !== undefined ? renderTemplate(legacyPersona, vars) : undefined;
      const manifestPath = join(ap.root, SEED_PROVENANCE_FILE);
      const manifest = readProvenance(manifestPath);

      const targets: Array<{ rel: string; path: string; desired: string | undefined; kind: 'persona' | 'doc' }> = [
        { rel: 'persona.md', path: join(ap.root, 'persona.md'), desired: docs.persona, kind: 'persona' },
        { rel: 'operating.md', path: join(ap.root, 'operating.md'), desired: docs.operating, kind: 'doc' },
        { rel: 'CLAUDE.md', path: join(ap.workDir, 'CLAUDE.md'), desired: docs.claude, kind: 'doc' },
      ];

      let agentChanged = false;
      for (const t of targets) {
        if (t.desired === undefined) continue; // e.g. the hub has no operating doc
        if (!existsSync(t.path)) {
          writeFileSync(t.path, t.desired, { mode: 0o600 });
          manifest[t.rel] = sha256(t.desired);
          agentChanged = true;
          continue;
        }
        const current = readFileSync(t.path, 'utf8');
        if (current === t.desired) {
          manifest[t.rel] = sha256(t.desired); // already current — just stamp provenance
          continue;
        }
        const isUnmodifiedStub =
          (manifest[t.rel] !== undefined && manifest[t.rel] === sha256(current)) ||
          (t.kind === 'persona' && legacyPersonaRendered !== undefined && current === legacyPersonaRendered) ||
          (t.kind === 'doc' && CONTRACT_SENTINELS.some((s) => current.includes(s))) ||
          // the HUB's CLAUDE.md is persona+tools (no contract sentinel), so also treat a
          // doc that BEGINS with the rendered legacy stub persona as a generated stub.
          (t.kind === 'doc' && legacyPersonaRendered !== undefined && current.startsWith(legacyPersonaRendered)) ||
          // Locale-agnostic catch (review fold-in): a CLAUDE.md that is exactly the
          // CURRENT persona + tools — it starts with the rendered persona but is missing
          // the now-desired operating doc — is the persona-only generated stub. This
          // regenerates the hub's CLAUDE.md to fold in its operating doc even when no
          // legacy-persona seed exists or config.locale.agentProse != the seeded locale.
          (t.rel === 'CLAUDE.md' && docs.operating !== undefined && current.startsWith(docs.persona) && !current.includes(docs.operating));
        if (isUnmodifiedStub) {
          writeFileSync(t.path, t.desired, { mode: 0o600 });
          manifest[t.rel] = sha256(t.desired);
          agentChanged = true;
        } else {
          preserved.push(`${sanitizeId(agent.id)}/${t.rel}`);
        }
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      if (agentChanged) changed.add(sanitizeId(agent.id));
    } catch (err) {
      log.error(`re-seed failed for ${agent.id}`, { error: String(err) });
    }
  }
  return { changed: [...changed], preserved };
}

/** Deep-equal two settings.json strings, tolerant of formatting (parse + restringify). */
function sameSettings(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}

/**
 * DELIBERATE re-seed of each agent's Claude Code settings.json from its CURRENT
 * security profile + the global permission posture (FIX-agent-permissions-permissive).
 * Unlike the docs, settings.json is a GENERATED artifact: it is overwritten whenever
 * the on-disk file is still machine-generated — recognized by a provenance-hash match
 * OR by deep-equality with the render under EITHER posture (the prior machine output,
 * before the operator flips the knob) — and PRESERVED only when it is a genuine
 * operator edit. The deny list is regenerated from the profile every pass. Returns
 * the agents whose settings.json changed; the caller restarts them so a FRESH Claude
 * Code session reads the new permissions (an adopted session keeps the old file).
 * Permissive-mode profiles have no settings.json, so they are skipped.
 */
export function reseedAgentSettings(deps: ScaffoldDeps): ReseedResult {
  const changed = new Set<string>();
  const preserved: string[] = [];
  for (const agent of deps.config.agents) {
    try {
      const ap = agentPaths(deps.paths, agent.id);
      if (!existsSync(ap.root)) continue; // never scaffolded — scaffoldAgent owns first-write
      const desired = strictSettings(agent, deps.config, ap.root);
      const path = join(ap.configRoot, 'settings.json');
      const manifestPath = join(ap.root, SEED_PROVENANCE_FILE);
      const manifest = readProvenance(manifestPath);
      const rel = 'settings.json';

      const stamp = (): void => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

      // A PERMISSIVE-mode profile must have NO settings.json — it launches with
      // --dangerously-skip-permissions. On a strict→permissive profile change a stale
      // machine-generated settings.json would otherwise survive (writeIfAbsent never
      // overwrites it) and its `ask` rules re-introduce the very per-command Bash prompt
      // bypass removes (the recurring "stuck-permission" wedge — e.g. RELAY). REMOVE the
      // leftover when it is machine-generated; PRESERVE a genuine operator edit.
      if (desired === undefined) {
        if (!existsSync(path)) continue;
        const current = readFileSync(path, 'utf8');
        const variants = [
          strictSettings(agent, { ...deps.config, defaultPermissionMode: 'permissive' }, ap.root),
          strictSettings(agent, { ...deps.config, defaultPermissionMode: 'ask' }, ap.root),
        ].filter((v): v is string => v !== undefined);
        const isGeneratedStub =
          (manifest[rel] !== undefined && manifest[rel] === sha256(current)) ||
          variants.some((v) => sameSettings(v, current));
        if (isGeneratedStub) {
          rmSync(path, { force: true });
          delete manifest[rel];
          stamp();
          changed.add(sanitizeId(agent.id));
        } else {
          preserved.push(`${sanitizeId(agent.id)}/settings.json`);
        }
        continue;
      }
      if (!existsSync(path)) {
        ensureDir(ap.configRoot, 0o700);
        writeFileSync(path, desired, { mode: 0o600 });
        manifest[rel] = sha256(desired);
        stamp();
        changed.add(sanitizeId(agent.id));
        continue;
      }
      const current = readFileSync(path, 'utf8');
      if (sameSettings(current, desired)) {
        manifest[rel] = sha256(desired); // already current — just stamp provenance
        stamp();
        continue;
      }
      const variants = [
        strictSettings(agent, { ...deps.config, defaultPermissionMode: 'permissive' }, ap.root),
        strictSettings(agent, { ...deps.config, defaultPermissionMode: 'ask' }, ap.root),
      ].filter((v): v is string => v !== undefined);
      const isGeneratedStub =
        (manifest[rel] !== undefined && manifest[rel] === sha256(current)) ||
        variants.some((v) => sameSettings(v, current));
      if (isGeneratedStub) {
        writeFileSync(path, desired, { mode: 0o600 });
        manifest[rel] = sha256(desired);
        changed.add(sanitizeId(agent.id));
      } else {
        preserved.push(`${sanitizeId(agent.id)}/settings.json`);
      }
      stamp();
    } catch (err) {
      log.error(`settings re-seed failed for ${agent.id}`, { error: String(err) });
    }
  }
  return { changed: [...changed], preserved };
}

/** A product-profile overlay (#104). Narrow, explicit semantics — see applyProfileOverlay. */
export interface ProfileOverlay {
  /** Shallow-merged into the seed's scheduler block (e.g. learningLoop:false). */
  scheduler?: Record<string, unknown>;
  /** Agent ids to mark hidden:true (trim the product fleet; the rest stays default-stopped). */
  hideAgents?: string[];
  /** #399: shallow-merged into the seed's cs block (e.g. autoReply/notifyOwner on for the KKV product). */
  cs?: Record<string, unknown>;
}

/**
 * Apply a product-profile overlay onto a parsed seed config object (#104). PURE:
 * returns a new object, never mutates the input. The own fleet installs with NO
 * profile and is untouched. Intentionally narrow semantics (no generic deep-merge,
 * no surprise top-level overrides):
 *  - scheduler: shallow-merged, so an off-switch like learningLoop:false lands
 *    without dropping the base catch-up windows.
 *  - hideAgents: sets hidden:true on the listed agents (excludes them from the
 *    roster, scheduler and routing); each agent's other fields are preserved.
 * Unknown overlay keys (e.g. a "$comment" doc field) are ignored. Billing is
 * deliberately NOT settable here: the sanctioned single writer of billing.mode is
 * the operator billing route (subscription stays the default), so a profile never
 * flips it.
 */
export function applyProfileOverlay(seed: Record<string, unknown>, overlay: ProfileOverlay): Record<string, unknown> {
  const out: Record<string, unknown> = { ...seed };
  if (overlay.scheduler && typeof overlay.scheduler === 'object') {
    const base = typeof seed.scheduler === 'object' && seed.scheduler !== null ? (seed.scheduler as Record<string, unknown>) : {};
    out.scheduler = { ...base, ...overlay.scheduler };
  }
  if (Array.isArray(overlay.hideAgents) && overlay.hideAgents.length > 0) {
    const hide = new Set(overlay.hideAgents);
    const agents = Array.isArray(seed.agents) ? seed.agents : [];
    out.agents = agents.map((a) => {
      const agent = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {};
      return hide.has(agent.id as string) ? { ...agent, hidden: true } : agent;
    });
  }
  // #399: cs block shallow-merged (e.g. the KKV product turns on autoReply + owner-notify); the own
  // fleet installs with NO profile, so its cs block is untouched (no auto-reply, no owner-notify).
  if (overlay.cs && typeof overlay.cs === 'object') {
    const base = typeof seed.cs === 'object' && seed.cs !== null ? (seed.cs as Record<string, unknown>) : {};
    out.cs = { ...base, ...overlay.cs };
  }
  return out;
}

/**
 * Install the committed seed config on first run only (never overwrites). With a
 * `profile`, the matching `seed/profiles/<profile>.config.json` overlay is applied
 * (#104); the own fleet installs with no profile and gets the seed verbatim.
 */
export function installSeedConfig(paths: StatePaths, opts: { locale?: string; profile?: string } = {}): boolean {
  if (existsSync(paths.configFile)) return false;
  const seedText = readTextIfExists(join(seedDir(), 'seed.config.json'));
  if (seedText === undefined) throw new Error('seed/seed.config.json missing from the installation');
  let text = seedText;
  // Re-serialize only when a profile or locale override is in play; otherwise the
  // own-fleet path writes the seed verbatim (byte-for-byte unchanged).
  if (opts.profile !== undefined || opts.locale === 'en' || opts.locale === 'hu') {
    let parsed = JSON.parse(seedText) as Record<string, unknown>;
    if (opts.profile !== undefined) {
      const overlayText = readTextIfExists(join(seedDir(), 'profiles', `${opts.profile}.config.json`));
      if (overlayText === undefined) throw new Error(`seed profile '${opts.profile}' not found under seed/profiles/`);
      parsed = applyProfileOverlay(parsed, JSON.parse(overlayText) as ProfileOverlay);
      // Record the profile so a later additive roster migration (#129) can re-apply
      // its visibility overlay to newly propagated agents (own fleet: no profile).
      parsed.installedProfile = opts.profile;
    }
    if (opts.locale === 'en' || opts.locale === 'hu') {
      parsed.locale = { default: opts.locale, agentProse: opts.locale };
    }
    text = JSON.stringify(parsed, null, 2) + '\n';
  }
  ensureDir(dirname(paths.configFile), 0o700);
  createExclusive(paths.configFile, text, 0o600);
  return true;
}

export interface RosterMigration {
  /** Ids of seed agents freshly added to the running roster. */
  added: string[];
  /** Ids of security profiles freshly added (referenced by the new agents). */
  addedProfiles: string[];
}

/**
 * Additive seed-roster migration (#129) — the roster half of the update path
 * (#106/#113). installSeedConfig is SEED-ONCE, so a running config never gains the
 * agents/profiles a later seed introduces (e.g. support, the bookkeeper). This runs
 * at boot AFTER installSeedConfig and propagates ONLY what is missing. Invariants,
 * non-negotiable:
 *  - ADDITIVE-ONLY: an agent/profile already present is NEVER overwritten or removed
 *    (operator config sovereignty). Only ids absent from the running config are added.
 *  - DORMANT GATE: a seed agent marked `dormant: true` is NOT propagated — it is a
 *    go-live gate (the bookkeeper waits on its financial-data enforcement + QA).
 *  - PROFILE-AWARE (#129 (A)): if the running config records an `installedProfile`,
 *    that profile's visibility overlay (hideAgents) is re-applied to the added
 *    agents, so a product agent stays visible while an internal one is hidden. The
 *    own fleet has no installedProfile => agents are added visible (as before).
 *  - IDEMPOTENT + ATOMIC + BACKED-UP: nothing to add => no write; otherwise the prior
 *    config is copied to `<config>.bak` and the new one written atomically.
 * Returns the freshly added agent + profile ids (the caller scaffolds + the
 * supervisor reconciler spawns them). A malformed/unreadable running config is left
 * untouched (installSeedConfig owns first write; we never create or repair here).
 */
/**
 * PURE planner for migrateSeedRoster (no IO) — computes the additive merge so the
 * invariants can be unit-tested with synthetic input. Returns undefined when there
 * is nothing to do (the caller writes nothing — idempotent).
 *
 * Auto-migration runs ONLY for a PROFILED (sold-product) deployment — one whose
 * running config carries an `installedProfile`. The own fleet and tests have none,
 * so they are returned untouched (no roster-dump into a deliberately small fleet).
 * Within a profiled deployment the visibility is FAIL-CLOSED: a migrated agent is
 * hidden unless it is explicitly `productVisible: true` (a future/unmarked agent
 * never leaks into the customer surface). `productVisible` is the single source of
 * truth for that decision (no deny-list).
 */
export function planSeedRosterMigration(
  running: Record<string, unknown>,
  seed: Record<string, unknown>,
): { merged: Record<string, unknown>; added: string[]; addedProfiles: string[] } | undefined {
  if (!Array.isArray(running.agents) || !Array.isArray(seed.agents)) return undefined;
  // GATE: only a profiled product deployment auto-migrates its roster.
  const profile = typeof running.installedProfile === 'string' && running.installedProfile.trim() !== '' ? running.installedProfile : undefined;
  if (profile === undefined) return undefined;

  const runningAgents = running.agents as Array<Record<string, unknown>>;
  const haveIds = new Set(runningAgents.map((a) => sanitizeId(String(a.id ?? ''))));
  // Additive + dormant-gated: only seed agents absent from the running roster and not
  // marked dormant (the go-live gate) are candidates.
  const candidates = (seed.agents as Array<Record<string, unknown>>).filter(
    (a) => typeof a.id === 'string' && a.id.trim() !== '' && a.dormant !== true && !haveIds.has(sanitizeId(a.id)),
  );
  if (candidates.length === 0) return undefined;

  // FAIL-CLOSED visibility: a migrated agent is hidden unless explicitly productVisible.
  const additions = candidates.map((a) => (a.productVisible === true ? a : { ...a, hidden: true }));

  // Additive security profiles: any profile a new agent references that the running
  // config lacks is copied from the seed (else the guard would not resolve).
  const runningProfiles = Array.isArray(running.securityProfiles) ? (running.securityProfiles as Array<Record<string, unknown>>) : [];
  const haveProfiles = new Set(runningProfiles.map((p) => String(p.id ?? '')));
  const seedProfiles = Array.isArray(seed.securityProfiles) ? (seed.securityProfiles as Array<Record<string, unknown>>) : [];
  const addedProfiles: Array<Record<string, unknown>> = [];
  for (const a of additions) {
    const pid = typeof a.securityProfile === 'string' ? a.securityProfile : '';
    if (pid === '' || haveProfiles.has(pid)) continue;
    const def = seedProfiles.find((p) => String(p.id ?? '') === pid);
    if (def !== undefined) {
      addedProfiles.push(def);
      haveProfiles.add(pid);
    }
  }

  const merged: Record<string, unknown> = {
    ...running,
    agents: [...runningAgents, ...additions],
    ...(addedProfiles.length > 0 ? { securityProfiles: [...runningProfiles, ...addedProfiles] } : {}),
  };
  return {
    merged,
    added: additions.map((a) => sanitizeId(String(a.id))),
    addedProfiles: addedProfiles.map((p) => String(p.id ?? '')),
  };
}

export function migrateSeedRoster(paths: StatePaths): RosterMigration {
  const empty: RosterMigration = { added: [], addedProfiles: [] };
  const runningText = readTextIfExists(paths.configFile);
  if (runningText === undefined) return empty; // never installed — not our job
  const seedText = readTextIfExists(join(seedDir(), 'seed.config.json'));
  if (seedText === undefined) return empty;

  let running: Record<string, unknown>;
  let seed: Record<string, unknown>;
  try {
    running = JSON.parse(runningText) as Record<string, unknown>;
    seed = JSON.parse(seedText) as Record<string, unknown>;
  } catch (err) {
    log.error('seed-roster migration skipped: config/seed not parseable', { error: String(err) });
    return empty;
  }

  const plan = planSeedRosterMigration(running, seed);
  if (plan === undefined) return empty; // not profiled / nothing to add — no write (idempotent)

  // Backup the prior config, then write atomically (tmp + rename).
  writeFileSync(`${paths.configFile}.bak`, runningText, { mode: 0o600 });
  atomicWriteFile(paths.configFile, JSON.stringify(plan.merged, null, 2) + '\n', 0o600);
  return { added: plan.added, addedProfiles: plan.addedProfiles };
}

/**
 * Seed the committed global skills into the live skills root (SEED-skills). Each
 * `seed/skills/<name>/` folder is copied to `<globalRoot>/<name>/` only when
 * absent — idempotent, and it NEVER overwrites an operator-edited skill. Returns
 * the names freshly installed.
 */
export function installSeedSkills(globalRoot: string): string[] {
  const src = join(seedDir(), 'skills');
  if (!existsSync(src)) return [];
  ensureDir(globalRoot, 0o700);
  const installed: string[] = [];
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dst = join(globalRoot, entry.name);
    if (existsSync(dst)) continue; // never clobber an operator-edited skill
    cpSync(join(src, entry.name), dst, { recursive: true });
    installed.push(entry.name);
  }
  return installed;
}

/**
 * Seed per-agent (local) skills (FIX-agent-skills). Each
 * `seed/agent-skills/<agentId>/<name>/` folder is copied to the agent's live
 * `<agentsDir>/<id>/skills/<name>/` only when absent — idempotent, never clobbers
 * an operator-edited skill. Mirrors installSeedSkills but per-agent. Returns the
 * per-agent names freshly installed.
 */
export function installSeedAgentSkills(agentsDir: string, agentIds: string[]): Record<string, string[]> {
  const base = join(seedDir(), 'agent-skills');
  const out: Record<string, string[]> = {};
  if (!existsSync(base)) return out;
  for (const id of agentIds) {
    const sid = sanitizeId(id);
    const src = join(base, sid);
    if (!existsSync(src)) continue;
    const dstRoot = join(agentsDir, sid, 'skills');
    ensureDir(dstRoot, 0o700);
    const installed: string[] = [];
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dst = join(dstRoot, entry.name);
      if (existsSync(dst)) continue; // never clobber an operator-edited skill
      cpSync(join(src, entry.name), dst, { recursive: true });
      installed.push(entry.name);
    }
    if (installed.length > 0) out[sid] = installed;
  }
  return out;
}

/**
 * Seed the committed example extension plugin(s) (FIX-plugins) into the live
 * plugins dir on first run — copied only when absent (idempotent). Seeding makes
 * the example PRESENT; it stays DISABLED until the operator enables it (no plugin
 * runs unless enabled). Returns the names freshly installed.
 */
export function installSeedPlugins(pluginsDir: string): string[] {
  const src = join(seedDir(), 'plugins');
  if (!existsSync(src)) return [];
  ensureDir(pluginsDir, 0o700);
  const installed: string[] = [];
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dst = join(pluginsDir, entry.name);
    if (existsSync(dst)) continue;
    cpSync(join(src, entry.name), dst, { recursive: true });
    installed.push(entry.name);
  }
  return installed;
}

export function loadAgentToken(paths: StatePaths, agentId: string): string | undefined {
  const file = agentPaths(paths, agentId).tokenFile;
  const text = readTextIfExists(file);
  return text?.trim();
}
