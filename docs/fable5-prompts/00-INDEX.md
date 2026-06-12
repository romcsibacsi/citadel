# Fable 5 build prompts — CITADEL feature set (clean-room)

This folder holds **paste-ready build prompts** for the architect agent **Fable 5**, one per menu /
view of the system, plus the design system. Each prompt is a **behavioral + visual specification**
(WHAT to build), distilled clean-room from the reference system by a bridge that read the reference
GUI + code and wrote behavior only — **no code was copied**. Fable 5 builds original code from these
specs and must never see the reference implementation.

**How to use:** review each file, delete any you don't need, then hand the kept ones to Fable 5 one
at a time (or in small batches). Build order suggestion: design first, then Overview, then the rest.

**Status:** generated 2026-06-12. The operator will prune unneeded prompts.

## Files
- `01-design.md` — the visual design system (themes, tokens, layout shell, signature treatments, Tweaks panel).
- `02-overview.md` … one per menu item below.

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
