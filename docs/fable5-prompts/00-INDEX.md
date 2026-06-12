# Fable 5 build prompts — CITADEL feature set (clean-room)

This folder holds **paste-ready build prompts** for the architect agent **Fable 5**, one per menu /
view of the system, plus the design system. Each prompt is a **behavioral + visual specification**
(WHAT to build), distilled clean-room from the reference system by a bridge that read the reference
GUI + code and wrote behavior only — **no code was copied**. Fable 5 builds original code from these
specs and must never see the reference implementation.

**How to use:** review each file, delete any you don't need, then hand the kept ones to Fable 5 one
at a time (or in small batches). Build order suggestion: design first, then Overview, then the rest.

**Status:** generated 2026-06-12. The operator will prune unneeded prompts.

## Files (complete — 2026-06-12)
- `01-design.md` — visual design system (themes, tokens, layout shell, signature treatments, Tweaks panel).
- `02-overview.md` — Overview (Áttekintés): stat row + team constellation + activity feed.
- `03-agents.md` — Agents (Ügynökök): roster, agent detail (lifecycle, watch+type terminal, security/team/auto-restart config, avatar), create-agent.
- `04-team.md` — Team (Csapat): hierarchy constellation + team editor (reportsTo/delegatesTo).
- `05-kanban.md` — Kanban: columns, card tiles, card modal (comments/approve/archive/breakdown), new-card, filters, archive.
- `06-messages.md` — Messages (Üzenetek): thread list, conversation, compose/operator-post.
- `07-schedules.md` — Schedules (Ütemezések): list/timeline/week, create-edit form, prompt-expand wizard, pending-retry queue.
- `08-memory.md` — Memory (Memória): list + filters (tiers/sector/search), save/edit/delete, stats, graph, recall.
- `09-log.md` — Log (Napló): daily-log entries + digest.
- `10-skills.md` — Skills (Skillek): two-tier global/agent skills, create/assign/import/delete, governance.
- `11-ideas.md` — Idea box (Ötletláda): list + status filters, new idea, promote→card, archive, reconcile, breakdown.
- `12-background.md` — Background tasks (Háttér): detached one-shot runner (launch/track/cancel/output).
- `13-mcp.md` — MCP / connectors: catalog + configured connectors, add/configure/remove.
- `14-status.md` — Status (Státusz): token-usage/budget cards, summary/timeline/details, tool-call log.
- `15-autonomy.md` — Autonomy (Autonómia): the per-category autonomy ladder (level/maxLevel/locked, hard-locked categories).
- `16-vault.md` — Vault: secrets grid (metadata only), set/reveal/delete, bindings/sync, scan/import.
- `17-migration.md` — Migration (Költöztetés): import a legacy assistant's memories/persona into an agent (scan → findings → import).
- `18-updates.md` — Updates (Frissítések): check/apply self-update + preflight safety.
- `19-studio.md` — Studio (Stúdió): media generation (image/video), async job, params, gallery, GPU lock.
- `20-settings.md` — Settings (Beállítások): general/branding/locale, appearance/Tweaks, channel (chat/Telegram) config.
- `21-activity.md` — Activity (Aktivitás): full chronological fleet-event feed.

**Build order suggestion:** 01-design → 02-overview → 03/04 (agents/team) → 05/06 (kanban/messages) →
the rest as needed. Each is independent enough to build + verify in a headless browser before the next.

## Menu items covered (the **homelab** view is intentionally EXCLUDED)
Overview (Áttekintés), Agents (Ügynökök), Team (Csapat), Kanban, Messages (Üzenetek),
Schedules (Ütemezések), Memory (Memória), Log (Napló), Background tasks (Háttér), Skills (Skillek),
MCP / connectors, Migration (Költöztetés), Status (Státusz), Autonomy (Autonómia), Vault,
Idea box (Ötletláda), Updates (Frissítések), Studio (Stúdió), Settings (Beállítások), Activity (Aktivitás).

## Clean-room rule (in every prompt)
Fable 5 builds from the prompt's behavioral spec ONLY; it must not look for or import any existing
implementation. All visible appearance follows `01-design.md` (the design system); each menu prompt
specifies that view's layout, controls, opened cards/modals, fields, buttons and flows in detail.
Code is English; operator-facing strings ship in both Hungarian (default) and English.
