---
name: nexus-delegate-task
description: NEXUS orchestrator delegál — dev/build/research/media feladatot NEM maga csinál, hanem kanban-kártyán kiadja a megfelelő ágensnek (FORGE/SPARK/SIGMA/RELAY/ORACLE/CREATIVE) és in_progress-szel dispatch-eli. Akkor használd, amikor érdemi munka érkezik (kódolás, build, kutatás, kép/videó), mielőtt magad nekiállnál.
---

# NEXUS feladat-delegálás (kanban dispatch)

## Mikor használd
Amikor érdemi feladat érkezik (kódolás, build, fix, kutatás, adat, média) — NEXUS hubként **delegál, nem implementál maga**. Csak triviális, 1-2 lépéses dolgot csinálj közvetlenül (státusz-lekérdezés, egy komment, egy memória). Minden, ami egy senior/medior dev körébe esik → FORGE (trusted build) vagy SPARK (kísérleti, sandbox). Adat → SIGMA, homelab/netops → RELAY, kutatás → ORACLE, kép → CREATIVE, videó → REEL/SCREENER, külső videó → ARGUS.

## Eljárás
1. **Kártya létrehozása** a megfelelő assignee-vel:
   ```bash
   AUTH="Authorization: Bearer $(cat /home/uplinkfather/CITADEL/citadel/store/.dashboard-token)"; BASE=http://localhost:3420
   curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/kanban" \
     -d '{"title":"...","description":"... pontos scope + elvárt eredmény","assignee":"forge","priority":"normal","project":"CITADEL fejlesztés","status":"todo"}'
   ```
   (Vagy ötletládából: `POST /api/ideas/<id>/promote` — FIGYELEM: ez `assignee:nexus`-t állít, utána PUT-tal írd át a valódi ágensre.)
2. **Dispatch**: húzd in_progress-re — ez felébreszti az ágenst inter-agent üzenettel (Option D):
   ```bash
   curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/kanban/<ID>/move" -d '{"status":"in_progress"}'
   ```
3. Az ágens dolgozik, kommentel, és `done`-ra húzza. Te koordinálsz, nem kódolsz.

## Buktatók
- **A dispatch CSAK akkor fut le, ha a cél-ágens tmux session-je él** (`isRunning`). Ha nem fut, a kártya némán in_progress marad, üzenet nélkül. Ellenőrizd: `tmux ls | grep agent-<nev>`. Ha nem fut, indítsd el / jelezd az operátornak.
- `POST /api/ideas/<id>/promote` defaultja `assignee:nexus` — mindig írd át PUT-tal a valódi végrehajtóra, különben magadra osztod.
- Az operátornak a **kanban boardon kell látnia** a feladatot — ha csak az ötletládába teszed, ő nem látja feladatként. Promote-old kártyára.
- Saját magadra (`assignee:nexus`) ne dispatch-elj build-munkát — az pont a delegálás elmaradása.
- **Érvényes kanban státuszok: `planned` / `in_progress` / `waiting` / `done`** (DB CHECK constraint). Bármi más (pl. `todo`, `backlog`) → `{"error":"Szerver hiba"}`. Új kártyát `planned`-del (operátor-döntéshez `waiting`-gel) hozz létre, dispatch-hez `in_progress`.

## Ellenőrzés
- A kártya megjelenik a boardon (`GET /api/kanban`) a helyes assignee-vel.
- in_progress után az ágens kapott üzenetet (a session reagál) — ha 1-2 audit-kör után sem mozdul, a kanban-audit pingeli/eszkalál.
