---
name: kanban-audit
description: 4 óránkénti kanban-tábla audit. Tisztítás (7+ napos done archiválás) + beakadt task-ok számon kérése (előző audit óta nem mozdult in_progress -> ping az assignee-nek). Csendben fut, csak fontosnál szól.
---

# Kanban 4 órás audit

8:00 / 12:00 / 16:00 / 20:00. Csendes heartbeat: CSAK akkor írj a beállított élő csatornán, ha tényleg fontos (3+ beakadt task vagy 48h+ blokker). Munkakönyvtár: `{{INSTALL_DIR}}`. Minden DB-művelet a dashboard API-n (Bearer token: `store/.dashboard-token`) — `sqlite3` CLI NINCS telepítve.

## 0. Autonómia-szint (KÖTELEZŐ ELŐSZÖR)
```bash
jq -r '.categories[]|select(.key=="kanban_archive_done" or .key=="kanban_stuck_nudge")|"\(.key) \(.level)"' {{INSTALL_DIR}}/store/autonomy-config.json 2>/dev/null
```
- `kanban_archive_done` (2. lépés): level 3 → archiválj magától. level 2 → ne archiválj, javasold a csatornán és várj jóváhagyást. level 1 → csak jelezd a számot.
- `kanban_stuck_nudge` (4. lépés): level 3 → pingeld az assignee-t magától, és CSAK 2 eredménytelen audit-kör után eszkalálj **az operátorhoz**. level 2 → ne pingelj magadtól, javasold **az operátornak** a csatornán. level 1 → csak listázd.
- Ha a config hiányzik / a kulcs nincs benne → default level 3.

## 1. State beolvasás
```bash
LAST=$(jq -r '.last_audit_at // 0' {{INSTALL_DIR}}/store/kanban-audit-state.json 2>/dev/null || echo 0)
NOW=$(date +%s)
AUTH="Authorization: Bearer $(cat store/.dashboard-token)"; BASE=http://localhost:3420
CARDS=$(curl -s -H "$AUTH" "$BASE/api/kanban")   # id,title,status,assignee,updated_at,...
```
Első futáskor `LAST=0` → ne pingelj senkit, csak állítsd be a state-et a végén.

## 2. Tisztítás: 7+ napos done archiválás (level 3)
A `CARDS`-ból szűrd: `status=done`, `archived_at` üres, `updated_at < NOW-7*86400`. Mindegyikre:
```bash
curl -s -X POST -H "$AUTH" "$BASE/api/kanban/<ID>/archive"
```
(level 2 → ne archiválj, csak javasold; level 1 → csak a darabszám.)

## 3. Beakadt task detektálás (előző audit ÓTA nem mozdult)
A `CARDS`-ból: `status=in_progress`, `archived_at` üres, `updated_at < LAST`. Számold ki kártyánként a `(NOW-updated_at)/3600` órát.

## 4. Beakadt → ping az assignee-nek (level 3, kivéve nexus / üres assignee)
```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/messages" \
  -d '{"from":"nexus","to":"<ASSIGNEE>","content":"Kanban-audit: a <ID> (<title>) <H>h-ja in_progress mozgás nélkül. Frissítsd a státuszt (done/waiting) vagy kommenteld mi blokkol."}'
```
(level 2 → ne pingelj, javasold az operátornak; level 1 → csak listázd.)

## 5. State frissítés (a VÉGÉN)
```bash
echo "{\"last_audit_at\": $NOW}" > {{INSTALL_DIR}}/store/kanban-audit-state.json
```

## 6. Csatorna csak ha fontos
- 3+ beakadt task, vagy 48h+ `waiting` blokker, vagy 3+ delegálatlan (assignee üres) kártya → rövid üzenet a csatornán.
- Egyébként **csendes** (egy „csendes kanban-audit" sor a transzkriptbe elég).

## Buktatók
- „Előző audit óta nem mozdult" = `updated_at < LAST` (NEM abszolút 24h küszöb).
- Ne archiválj <7 napos done-t. Ne pingeld saját magad (`assignee=nexus`) vagy üres assignee-t.
- Első futás (LAST=0) → ne pingelj, csak inicializáld a state-et.

## Ellenőrzés
- A state-fájl frissült a futás végén (`cat store/kanban-audit-state.json`).
- Az archive/message hívások 200-at adtak.
