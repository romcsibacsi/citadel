---
name: agent-stuck-permission-prompt
description: NEXUS recovery — akkor használd, amikor egy delegált kanban-kártya régóta (>30-60 perc) in_progress, nincs kimenet és nem reagál pingre; valószínűleg a session egy tool-permission promptnál ragadt.
---

# Beragadt ágens — tool-permission prompt feloldása

## Mikor használd
Egy delegált kártya gyanúsan régóta `in_progress`, és:
- nincs új komment/kimenet a kártyán (`agentctl kanban board` / a dashboard kanban-nézete nem mozdul),
- a célágens nem reagál inter-agent pingre (`agentctl msg send <agent> ...`),
- a falióra-idő meghaladja a normális munka idejét (kb. >30-60 perc mozgás nélkül).

Ez a klasszikus tünete annak, hogy az interaktív Claude Code session egy **tool-permission promptnál** (ask-szabály) megállt és emberi/operátori választ vár. Nem hibázott le, csak blokkol.

NE keverd össze valódi hosszú munkával: build, kutatás, videó-render simán lehet 30+ perc. Előbb a tüneteket nézd (mozdul-e a kimenet, válaszol-e pingre), csak utána lépj.

## Eljárás
1. **Állapot a dashboardon / aktivitás-táblán.** Nyisd a Fleet- és az adott Agent-nézetet a dashboardon. Ott látszik az ágens running / busyState állapota és a live watch (SSE) terminál-kép. Kanban-oldalról: `agentctl kanban board` — ott a kártya, az assignee és az utolsó mozgás. Ha a live watch egy permission-/engedély-prompton (pl. „Allow tool …?”) áll, akkor a session beragadt, de a runtime él.
2. **Ping a kártya/üzenet csatornán.** Adj egy könnyű lökést: `agentctl msg send <agent> "Élsz? Beragadtál egy permission-prompton? Reagálj 1 sorban."` és tegyél egy kommentet a kártyára: `agentctl kanban comment <id> "Audit: régóta in_progress, kimenet nélkül — ellenőrzöm a session-t."`. Ha erre megmozdul a kimenet, kész, vissza a normál koordinációhoz.
3. **Ha a session FUT, de prompton ragadt → operátori/terminál-válasz.** A választ (jóváhagyás vagy Escape/elutasítás) a **dashboard Agent terminál-nézetéből** (live watch + type, SSE-n keresztül) lehet beküldeni — ezt te jelzed az operátornak, vagy ha hozzáférsz, a terminál-nézetből küldöd. Tipikusan: a kívánt választ begépeled (y/Enter, vagy Escape az elvetéshez). A session a supervisor/watcher tulajdona — a terminál-nézet a hivatalos input-csatorna hozzá.
4. **Ha a session NEM FUT → jelezd az operátornak az újraindítást.** Ne te indítgasd: `agentctl msg send operator "A(z) <agent> session nem fut (dashboard: not running), a #<id> kártya in_progress-ben áll. Kérlek a supervisor/watcher reconcilerrel indítsd újra a session-t."` A reconciler a kívánt-állapot alapján visszahozza a session-t; a kártya in_progress marad, így újraébresztéskor folytatható.
5. **Dokumentáld.** Tegyél egy záró kommentet a kártyára arról, mi történt (prompt-válasz beküldve / operátor értesítve újraindításra), hogy az audit-kör lássa.

## Buktatók
- **NE piszkáld kézzel a multiplexer-sessiont** (a régi listáz/küld mechanika tilos). A sessionöket a supervisor/watcher birtokolja és tartja életben; a kézi beavatkozás ütközik a reconcilerrel. Az állapotot a dashboardról olvasd, az inputot a terminál-nézetből (SSE) küldd.
- **Ne dobd vissza azonnal `planned`/`todo`-ra a kártyát**: ha a session él és csak prompton áll, a válasz beküldése folytatja a munkát — a visszadobás elveszítheti a haladást. Csak akkor mozgasd, ha az operátor tiszta újraindítást kért.
- **Türelmetlen ping spam tilos.** Egy ping + egy komment elég; a permission-prompt nem ettől old fel. A tényleges feloldás a terminál-válasz vagy az operátori restart.
- **Ne keverd a „nem fut” és a „prompton ragadt” esetet.** Más a teendő: előbbinél restart (operátor + reconciler), utóbbinál terminál-válasz. A dashboard running/busyState mezője dönt.
- **Engedélyt magadtól ne emelj.** A hard-locked kategóriákat (publish, payment, data-delete, permission-change, external-message) nem oldhatod fel; ha a prompt ilyet kér, az operátor dönt — ne nyomj automatikusan „allow”-t a terminál-nézetben.
- **Ne adj API kulcsot / titkot a prompt válaszába.** A válasz csak engedélyezés/elvetés (y / Escape), nem credential.

## Ellenőrzés
- Az ágens kimozdult: új komment/kimenet jelenik meg a kártyán, vagy a dashboard live watch terminálja halad — a kártya érdemben mozog (`agentctl kanban board`).
- VAGY az operátor értesítve lett (`agentctl msg send operator ...`) a session újraindításáról, és a dashboardon a session ismét running.
- A kártyán záró audit-komment rögzíti, mi oldotta fel a blokkot.
