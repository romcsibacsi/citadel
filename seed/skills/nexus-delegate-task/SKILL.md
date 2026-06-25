---
pinned: true
name: nexus-delegate-task
description: NEXUS orchestrator delegál — dev/build/research/media feladatot NEM maga csinál, hanem kanban-kártyán kiadja a megfelelő ágensnek (FORGE/SPARK/SIGMA/RELAY/ORACLE/CREATIVE) és in_progress-szel dispatch-eli. Akkor használd, amikor érdemi munka érkezik (kódolás, build, kutatás, kép/videó), mielőtt magad nekiállnál.
---

# NEXUS feladat-delegálás (kanban dispatch)

## Mikor használd
Amikor érdemi feladat érkezik (kódolás, build, fix, kutatás, adat, média) — NEXUS hubként **delegál, nem implementál maga**. Csak triviális, 1-2 lépéses dolgot csinálj közvetlenül (státusz-lekérdezés, egy komment, egy memória). Minden, ami egy senior/medior dev körébe esik → FORGE (trusted build) vagy SPARK (kísérleti, sandbox). Adat → SIGMA, homelab/netops → RELAY, kutatás → ORACLE, kép → CREATIVE, videó → REEL/SCREENER, külső videó → ARGUS.

## Eljárás
1. **Kártya létrehozása** a megfelelő assignee-vel:
   ```bash
   agentctl kanban add "..." "... pontos scope + elvárt eredmény" forge
   ```
   (Vagy ötletládából indulj: `agentctl idea add "..."`, majd abból gyúrj kanban-kártyát a fenti `agentctl kanban add`-del a valódi végrehajtó ágensre címezve.)
2. **Dispatch**: húzd in_progress-re — ez felébreszti az ágenst inter-agent üzenettel (Option D):
   ```bash
   agentctl kanban move <ID> in_progress
   ```
3. Az ágens dolgozik, kommentel (`agentctl kanban comment <ID> "..."`), és `done`-ra húzza. Te koordinálsz, nem kódolsz.

## Buktatók
- **A dispatch CSAK akkor ér célt, ha a cél-ágens fut.** Ha nem fut, a kártya némán in_progress marad, üzenet nélkül. Ellenőrizd a dashboardról (activity board), hogy él-e az ágens; ha nem, jelezd az operátornak / kérd az indítását.
- Ötletládából (`agentctl idea add`) nem lesz automatikusan feladat egy ágensnek — mindig gyúrj belőle kanban-kártyát a valódi végrehajtóra címezve, különben senki nem kapja meg.
- Az operátornak a **kanban boardon kell látnia** a feladatot — ha csak az ötletládába teszed, ő nem látja feladatként. Tedd kanban-kártyára.
- Saját magadra (`assignee:nexus`) ne dispatch-elj build-munkát — az pont a delegálás elmaradása.
- **Érvényes kanban státuszok: `planned` / `in_progress` / `waiting` / `done`**. Bármi más (pl. `todo`, `backlog`) hibát ad. Új kártya `planned`-ben indul (operátor-döntéshez `waiting`), dispatch-hez húzd `in_progress`-re.

## Ellenőrzés
- A kártya megjelenik a boardon (`agentctl kanban board`) a helyes assignee-vel.
- in_progress után az ágens kapott üzenetet (a session reagál) — ha 1-2 audit-kör után sem mozdul, a kanban-audit pingeli/eszkalál.
