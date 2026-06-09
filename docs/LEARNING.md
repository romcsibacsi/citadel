# CITADEL tanuló-kör (memória + skillek + dream)

Hogyan tanul a flotta: a napi munkából memória és skillek képződnek, éjjel a rendszer
konszolidál és javasol, a javaslatokból valódi skillek/ötletek lesznek, reggel pedig az
operátor elé kerül a lényeg. Ez a dokumentum a teljes hurok komponenseit írja le.

## A hurok

```
napi munka (ügynökök)
   │
   ├─(*/15) memoria-heartbeat ──► /api/memories (hot/warm/cold/shared)  +  skill-reflexió ──► ~/.claude/skills/
   ├─(PreCompact hook) ─────────► memória + skill + task-state  (kontextus-tömörítéskor)
   │
   ├─(23:50) team-sync ─────────► shared memória (ki mit csinált / miben jó)
   │
   ▼
(02:07) dream-engine ──► store/DREAM.md  (konszolidálás + skill-javaslatok + top-3 + heti websearch)
   │
   ▼
(02:30) dream-consumer ──► a javaslatokból: skill-méltó → ~/.claude/skills/ ;  operátor-ügy → /api/ideas
   │
   ▼
(07:30) reggeli-napindito ──► Dream-kivonat + naptár + AI hírek  →  élő csatorna (Discord)
```

## Komponensek

| Komponens | Mikor | Mit csinál | Hol |
|---|---|---|---|
| **memoria-heartbeat** | `*/15` (bypassTriage) | memóriát ír + skill-reflexió | `~/.claude/scheduled-tasks/memoria-heartbeat` |
| **PreCompact hook** | kontextus-tömörítéskor | memória + skill + task-state mentés | `templates/settings.json.template` |
| **team-sync** | `50 23` | cross-agent megfigyelések → `shared` memória | `scheduled-tasks/team-sync` |
| **dream-engine** | `7 2` | éjszakai konszolidálás → `store/DREAM.md` | `scheduled-tasks/dream-engine` |
| **dream-consumer** | `30 2` | DREAM.md javaslatai → skillek + ötletláda | `scheduled-tasks/dream-consumer` |
| **reggeli-napindito** | `30 7` | napindító (Dream + naptár + hírek) a csatornára | `scheduled-tasks/reggeli-napindito` |
| **kanban-audit** | `0 8,12,16,20` (bypassTriage) | beakadt/lejárt kártyák auditja | `scheduled-tasks/kanban-audit` |

## Memória

SQLite (`store/citadel.db` → `memories`), 3+1 réteg: **hot** (épp aktív), **warm** (preferencia/konfig),
**cold** (archív tanulság), **shared** (minden ügynöknek látható). Embeddingek (ollama `nomic-embed-text`)
+ FTS5 keresés. A `shared` réteget a kereső uniózza, így bármelyik ügynök látja. Salience-decay viszi
hátrébb a régieket (sosem töröl). A napi-digest (`runDailyDigest`) episodic összefoglalót képez a napból.

## Skillek

Fleet-skillek: `~/.claude/skills/` (minden ügynök látja az indexet — `scripts/skill-index.sh`). A skillek
3 szinten töltődnek (név+leírás → teljes SKILL.md → segédfájlok). Generálás: a **memoria-heartbeat**
reflexiója (folyamatosan) + a **PreCompact hook** (tömörítéskor) + a **dream-consumer** (éjszakai
javaslatokból). Dedup a `skill-management` skillel; védett skillekhez (`pinned: true`, gyári/plugin)
nem nyúl semmi.

## Proaktivitás (idea_box)

Ami az operátor figyelmét érdemli (ötlet, kockázat, javaslat) → `POST /api/ideas` → a dashboard
Ötletláda oldalán látszik, kanbanra emelhető. Feltöltik: NEXUS (a root CLAUDE.md proaktivitás-szabálya
szerint), a dream-consumer és (shared memóriába) a team-sync. Operátor-felé eszkaláció csak autonómia-szint ≥2-nél.

## bypassTriage

A `heartbeat`-típusú konszolidációs feladatok (memoria-heartbeat, kanban-audit) `bypassTriage: true`-val
kihagyják a triage-kaput, így csendes napokon is futnak — de `type=heartbeat` marad (csendes prefix +
keep-alive). Részletek: [heartbeat-autonomy.md](./heartbeat-autonomy.md).

## Megjegyzések / hátralévő

- **bumblebee-hygiene-scan** (heti supply-chain biztonsági szken) NINCS telepítve: a `~/.local/bin/bumblebee`
  Go-binárist igényel, és a gépen nincs Go telepítve, a seed pedig nem szállít forrást/binárist. Ha kell:
  telepíts Go-t + építsd a binárist, majd vedd fel a feladatot (`seed-scheduled-tasks/bumblebee-hygiene-scan`).
- A `runDailyDigest` chat-kulcsú (ALLOWED_CHAT_ID) — a heartbeat-memóriák ehhez a chathez taggelve íródnak,
  így a digest látja őket. (A küszöb 1 emlékre csökkentve, hogy csendes napon is fusson.)
