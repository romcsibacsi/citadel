---
name: dream-engine
description: Éjszakai analízis-loop a SAJÁT CSAPAT (NEXUS + FORGE/SPARK/SIGMA/RELAY/SCREENER/ORACLE) aznapi munkájáról — memóriák, naplók, kanban. Konszolidál és reggelre priorizált javaslatokat "álmodik".
---

Te most a **Dream Engine** éjszakai analízis-loopot futtatod CITADEL alatt. ~02:07 van, az operátorod alszik — **NE küldj üzenetet semmilyen csatornára.** A kimenet egyetlen fájl: `/home/uplinkfather/CITADEL/citadel/store/DREAM.md`, amit reggel a Reggeli Napindító olvas fel.

A cél: **a saját csapatod aznapi munkáját átkonszolidálni és reggelre felkészülni** priorizált javaslatokkal. A csapat, akiknek a munkáját nézed: **NEXUS** (te, orchestrator) + **FORGE, SPARK, SIGMA, RELAY, SCREENER, ORACLE**. Csak ezt a rostert nézd — más névről (régi/upstream ágensek) ne is gondolkodj, azok nem léteznek itt.

Minden olvasást a dashboard API-n keresztül végezz (Bearer token: `store/.dashboard-token`), NE közvetlen `sqlite3` CLI-vel (az nincs telepítve). Munkakönyvtár: `/home/uplinkfather/CITADEL/citadel`.

## Bucket 1 — 🧠 A csapat 24h-s munkájának konszolidálása

Nézd át az elmúlt 24 óra memóriáit és napi naplóit a TELJES rosterre:

```bash
BASE=http://localhost:3420; AUTH="Authorization: Bearer $(cat store/.dashboard-token)"
# Minden agent memóriái (a lista created_at-et is ad — szűrj 24h-ra):
curl -s -H "$AUTH" "$BASE/api/memories?limit=200"
# Per-agent napi napló (mindegyikre):
for a in nexus forge spark sigma relay screener oracle; do
  curl -s -H "$AUTH" "$BASE/api/daily-log?agent=$a"
done
```

Foglald össze ágensenként 1-1 mondatban, MIT csinált a csapat tagja az elmúlt napban (ha semmit, "csendes nap"). Ez a "miből álmodunk" alap.

Keress mintázatot a csapat munkájában:
- Volt-e 3+ alkalommal manuálisan ismételt művelet, amit skill-be lehetne önteni?
- Két ágens egymás mellett, koordináció nélkül dolgozott ugyanazon? (delegálási rés)
- Visszatérő hiba→recovery, ami egy meglévő skill „Buktatók" szekciójába kívánkozik?

Output: 0–2 konkrét **skill-/folyamat-javaslat**, mindegyik: cím + 1 mondat indok + „flotta-szintű" vagy „agent: <név>".

## Bucket 2 — 🧹 Memória-egészség (SOHA törlés, csak COLD-ba mozgatás)

```bash
curl -s -H "$AUTH" "$BASE/api/memories/stats"   # total / withEmbedding / byTier
```

- Vektorizálatlan memóriák: jelezd hányat találtál (az async embedding-job amúgy bedolgozza; itt csak ellenőrzöl).
- Antikvált `hot` tier (>7 napja nem hivatkozott) → mozgasd `cold`-ba a tier-PUT-tal, SOHA ne törölj:
  ```bash
  curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' -d '{"tier":"cold"}' "$BASE/api/memories/<ID>"
  ```
- Pontos tartalmi duplikátum: jelezd, mozgasd cold-ba.

Output: rövid statisztika („X memória cold-ba helyezve, Y vektorizálatlan").

## Bucket 3 — 🎯 Holnapi top-3 (a csapat priorításai)

```bash
curl -s -H "$AUTH" "$BASE/api/kanban"   # nyitott kártyák: project, priority, assignee, status
```

Csoportosíts project szerint, súlyozz prioritás + aznapi aktivitás (napló/kanban-mozgás) szerint, és hozz ki **TOP-3 holnapi javaslatot**. Formátum soronként: `<project>: <kártya/akció> — <indok 1 mondat>`.

## Bucket 4 — 🌐 Külső lehetőség (heti 1×, nem minden éjjel)

Hetente 1-2×, NEM minden éjszaka: `WebSearch` új Claude Code / agentic-AI / a csapat tényleges projektjeihez illő skillekért/eszközökért. A relevanciát az operátorod **valós kanban-projektjeiből és a friss memóriákból** vezesd le (ne feltételezz piacot/témát). Szűrés: GitHub >100 csillag, utóbbi 90 napban aktív, világos README. Ha az elmúlt 7 napban már volt ajánlás (lásd a DREAM.md korábbi tartalmát), **skip**. Output: max 1 ajánlás (repo URL + 1 mondat: miért illik a csapat aktuális munkájához), vagy „Skip — heti limit / nincs releváns".

## Bucket 5 — 🛠 Skill-flotta egészség (csak NEM-védett skillek)

```bash
ls ~/.claude/skills/
grep -L "^pinned: true" ~/.claude/skills/*/SKILL.md 2>/dev/null   # nem kifejezetten védettek
```
**Védettek (sose javasold törlésre):** bármely skill `pinned: true` frontmatterrel, ÉS a gyári Claude Code / plugin skillek (pl. `discord:*`, `telegram:*`, `init`, `review`, `security-review`, `simplify`, `loop`, `schedule`, `claude-api`, `update-config`, `keybindings-help`, `verify`, `code-review`, `deep-research`). Output: 0–3 javaslat: „skill <név> antikvált (>30 nap), frissítés/törlés megfontolandó".

## Kimeneti formátum (`store/DREAM.md`)

```markdown
# 💭 Dream Engine — ÉÉÉÉ-HH-NN 02:07

## 🧠 A csapat tegnapi munkája
- NEXUS: ... | FORGE: ... | SPARK: ... | SIGMA: ... | RELAY: ... | SCREENER: ... | ORACLE: ...

## 💡 Skill-/folyamat-javaslatok
- (vagy „Nincs új javaslat")

## 🧹 Memória-egészség
… / … vektorizált, X hot→cold, Y duplikátum.

## 🎯 Holnapi top-3
1. … 2. … 3. …

## 🌐 Külső lehetőség
- (vagy „Skip")

## 🛠 Skill-flotta egészség
- (vagy „Minden skill aktív vagy védett")
```

## Szabályok

- **NE küldj üzenetet semmilyen csatornára** — a DREAM.md-t a reggeli napindító olvassa fel.
- Minden olvasás/írás a dashboard API-n vagy helyi fájlon megy; külső API csak a Bucket 5 WebSearch.
- Ha akadály van (DB-lock, hiányzó endpoint), tedd a DREAM.md végére egy `## ⚠️ Hibák` szekciót — reggel látszik.
- Záró sor: `*NEXUS, 02:XX — a csapat álmai elrendezve.*`
