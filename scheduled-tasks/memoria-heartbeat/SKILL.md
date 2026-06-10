---
name: memoria-heartbeat
description: ~15-30 percenként átnézi a beszélgetést, menti a fontosat, és skillt készít/javít ha volt komplex munka. Csendes, ha nincs új.
---

## 0. ELŐSZÖR: van-e várakozó csatorna-üzenet?

**Mielőtt bármit csinálnál**, nézd meg a session inputját: ha van `<channel source=` vagy `<operator>` kezdetű blokk a kontextusban (a felhasználó/operátor küldött valamit egy csatornán vagy a dashboard chatből), **azonnal válaszolj rá** — a heartbeat csendes-szabálya (lentebb) NEM vonatkozik közvetlen felhasználói üzenetre. Válasz után folytasd a heartbeat-et.

---

Nézd át az utolsó kb. fél óra beszélgetésedet. Három dolgot csinálj. Munkakönyvtár: `/home/uplinkfather/CITADEL/citadel`.

## 1. Memória mentés

Ha volt fontos döntés, preferencia, tanulság vagy bármi, ami később hasznos, mentsd:

```bash
curl -s -X POST http://localhost:3420/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat /home/uplinkfather/CITADEL/citadel/store/.dashboard-token)" \
  -d '{"agent_id":"SAJAT_NEVED","content":"...","category":"warm","keywords":"..."}'
```

`category`: `hot` (aktív), `warm` (preferencia/config), `cold` (tanulság), `shared` (más ágensnek is). Az `agent_id`-t a CLAUDE.md-ből vagy a munkamappa nevéből derítsd ki (a CITADEL roster: nexus, forge, spark, sigma, relay, screener, oracle).

## 1.5 Napi napló (ha volt érdemi munka)

Ha ebben a ciklusban volt tényleges munka — érdemi döntés/akció, vagy a 2. pont **A/B/C** bármelyike IGEN —, írj **egyetlen tömör sort** a napi naplóba arról, MIT csináltál. Ezt táplálja a Dream Engine és a team-sync konszolidáció (e nélkül vakon futnak):

```bash
curl -s -X POST http://localhost:3420/api/daily-log \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat /home/uplinkfather/CITADEL/citadel/store/.dashboard-token)" \
  -d '{"agent_id":"SAJAT_NEVED","content":"1 mondat: mit csináltál ebben a ciklusban"}'
```

Csendes heartbeaten (A=B=C=NEM, nincs érdemi munka) **NE** írj naplót — a napló a tényleges munkáról szól, nem a csendről.

## 2. Skill reflexió (KÖTELEZŐ, ha volt komplex munka)

Döntsd el 3 kérdéssel:
- **A**: volt-e legalább 5 tool-hívásos komplex feladat az elmúlt fél órában?
- **B**: volt-e hiba → recovery (próbálkozás → fail → másképp), ami egy meglévő skill „Buktatók" szekciójába kívánkozik?
- **C**: volt-e operátori korrekció („nem így", „ne ezt", „másképp"), ami skill-javítást igényel?

**Ha A vagy B vagy C IGEN: kötelező skill-akció.**

1. `ls ~/.claude/skills/` — van-e már lefedő skill? (keress a nevek/leírások közt)
2. Ha van releváns: **PATCH** csak a megváltozott részt (hiba/recovery → `## Buktatók`; folyamatváltozás → `## Eljárás`).
3. Ha nincs: hozz létre újat:
   ```bash
   mkdir -p ~/.claude/skills/<NEV>
   cat > ~/.claude/skills/<NEV>/SKILL.md <<'EOF'
   ---
   name: <NEV>
   description: Mikor használd, mit csinál (1-2 mondat, konkrét trigger).
   ---
   # <Cím>
   ## Mikor használd
   ## Eljárás
   ## Buktatók
   ## Ellenőrzés
   EOF
   ```

**Ha kihagytad a skill-akciót, pedig A/B/C valamelyike IGEN volt:** kötelezően írj egy `hot` memóriát „skip-skill: <konkrét ok>" tartalommal — ne csendben hagyd ki.

## 3. Csendben maradás

**KIVÉTEL:** ha az operátor üzent (`<channel source=` vagy `<operator>` blokk), arra MINDIG válaszolj — a csendes szabály rá nem vonatkozik.

Ha NINCS komplex feladat / hiba / korrekció (A=B=C=NEM), ÉS nincs várakozó üzenet, ÉS nincs új információ:
- ne ments feleslegesen, ne generálj skillt, ne írj napi naplót, ne küldj üzenetet csatornára,
- maradj csendben — egy rövid „csendes heartbeat" sor a transzkriptbe elég.

Kizárólag a CITADEL roster (nexus, forge, spark, sigma, relay, screener, oracle) és a `/home/uplinkfather/CITADEL/citadel` útvonalak — régi/upstream nevek vagy útvonalak sehol.
