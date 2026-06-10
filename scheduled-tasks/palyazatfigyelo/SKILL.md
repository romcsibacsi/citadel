---
name: palyazatfigyelo
description: Heti pályázat-figyelő — újra-ellenőrzi a HU/EU tech-pályázati forrásokat, és CSAK az ÚJ vagy VÁLTOZOTT, kis/induló tech céghez illő (non-dilutive) kiírást jelenti a csatornára. Csendes, ha nincs új. READ-ONLY, minden adat forrás-idézve.
---

Te most a **Pályázatfigyelő** heti futását végzed CITADEL alatt (NEXUS-ként jelentesz a csatornára). Hétfő ~08:00 van.

**Cél:** heti újra-ellenőrzés a vissza nem térítendő (non-dilutive), kis/induló TECH céghez illő pályázati forrásokon. Mindig a `docs/palyazatfigyelo-baseline.md`-hez (és a korábbi futásokhoz) hasonlítasz, és CSAK az ÚJ vagy VÁLTOZOTT releváns kiírást jelented — ne spammelj.

**Relevancia-szűrő:** kis/induló tech — digitalizáció, K+F, startup, mikro/kis-KKV. NEM releváns: nagyvállalat, mezőgazdaság, önkormányzat.

## Források (heti újra-ellenőrzés)
- **HU:** Palyazat.gov.hu, Széchenyi Terv Plusz (DIMOP+/GINOP+), Demján Sándor program, NGM/HIPA, NKFIH aktuális felhívások.
- **EU:** Horizon Europe / EIC (Accelerator), Digital Europe Programme (HaDEA).

A keresést WebSearch + WebFetch-csel végezd; minden adatot hivatalos forrás-linkkel idézz. READ-ONLY: ne tölts fel, ne jelentkezz be, ne adj be és ne cselekedj — csak figyelj és jelents.

## Eljárás
1. **Dátum:** `date` (Europe/Budapest) — a „közelgő határidő" számításához.
2. **Baseline:** olvasd be a `docs/palyazatfigyelo-baseline.md`-t (a már ismert kiírások + státusz). Ez a referencia.
3. **Korábbi futások:** nézd meg a `shared` memóriát (`keyword: palyazatfigyelo`), hogy mit jelentettél már.
4. **Források újra-ellenőrzése** a fenti listán: nyitott/közelgő kiírások, összeg, intenzitás, beadási határidő, jogosultság (illik-e a relevancia-szűrőre).
5. **Diff:** vesd össze a baseline-nal és a korábbi futásokkal — szűrd ki, ami már szerepel változatlanul. Csak az ÚJ vagy VÁLTOZOTT releváns kiírás marad.
6. **Jelentés (CSAK ha van új/változott releváns):** rövid, a csatornára. Kiírásonként: mi, mennyi (összeg/intenzitás), beadási határidő, miért illik (1 mondat) + hivatalos link. **Közelgő határidő (<14 nap) -> EMELD KI** (⚠️).
7. **Idea-box:** az akciózható új kiírásokat tedd az ötletládába:
   ```bash
   curl -s -X POST http://localhost:3420/api/ideas -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     -d '{"title":"<kiírás>","description":"<összeg/határidő/miért illik> + link","source":"palyazatfigyelo","category":"Pályázat"}'
   ```
8. **Memória:** a futás eredményét (mit találtál / nem találtál) mentsd `shared` memóriába (`keyword: palyazatfigyelo, <ISO-hét>`), hogy a következő futás diffelni tudjon.
9. **CSEND:** ha nincs ÚJ vagy VÁLTOZOTT releváns kiírás, NE írj a csatornára (csak a memória-frissítés). A csendes hét normális — ez `type=heartbeat`.

## Csatorna-jelentés formátum (ha van mit jelenteni)
- Telegram MarkdownV2, a Reggeli Napindító escaping-szabályaival (speciális karaktereket escapelni: `( ) . - + = ! { } [ ] | ~ > #`).
- Cím: 📣 *Pályázatfigyelő — új/változott kiírás*
- Kiírásonként 2-3 sor + hivatalos link; a <14 napos határidőt ⚠️-vel kiemeld.

## Buktatók
- READ-ONLY: soha ne jelentkezz be, ne tölts fel, ne adj be semmit — csak figyelsz és jelentesz.
- Forrás kötelező: minden számadat/dátum hivatalos link mellé; a másodlagos (pályázatíró-portál) adatot jelöld `ellenőrizendő`-nek.
- Ne spammelj: változatlan kiírást ne jelents újra. A baseline + a korábbi futások a referencia.
- Időérzékeny: a határidőket a futás napjához (`date`) viszonyítsd.

## Ellenőrzés
- Csak ÚJ/VÁLTOZOTT releváns kiírás ment a csatornára? (különben csend)
- Minden jelentett tétel hivatalos forrás-linkkel + (ha <14 nap) kiemelt határidővel?
- Az akciózhatók az idea-boxba kerültek (`category=Pályázat`), és a futás a `shared` memóriába?
