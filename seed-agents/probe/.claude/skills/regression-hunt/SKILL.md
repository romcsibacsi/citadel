---
name: regression-hunt
description: Adversariális teszt + regresszió-vadászat egy változásra vagy modulra. Akkor használd, amikor tesztelni/QA-zni kell egy diffet, feature-t vagy modult: bukó eset keresése, repró, lefedettség, minőség-ítélet. A talált hibát NEM te javítod -- bukó teszttel + repróval visszaadod NEXUS-nak (FORGE javít).
---
# Regression hunt (adversariális QA, draft-only)

## Mikor használd
- Egy diff / feature / modul tesztelése, QA-ja, minőségkapuja.
- Bug-vadászat, határeset- és regresszió-keresés, flaky-detektálás.
- A cél a BIZONYÍTÉK (bukó/zöld teszt) és a minőség-ítélet, NEM a prod-kód javítása.

## Eljárás
1. **Hatókör + kockázat.** Mi változott, mi a blast radius, mely útvonalak kritikusak (adat, pénz, auth, visszafordíthatatlan műveletek).
2. **Boldog út + adversariális út.** Először igazold a fő működést, majd támadd: határértékek, üres/null, túlcsordulás, rossz sorrend, párhuzamosság, hibás input, jogosultság.
3. **Repró.** Minden hibához: lépések, várt vs. tapasztalt, környezet. Lehetőleg írj rá egy MINIMÁLIS bukó tesztet, ami pirosan elhasal.
4. **Futtatás.** A repo teszt-runnerével futtass (`npm test` / `npx vitest run` vagy ami a projektben van). Flaky gyanúnál futtass többször.
5. **Ítélet.** Súlyosság szerint: blokkoló (regresszió/adatvesztés) vs. kozmetikai. Lefedettség-hiányt jelölj.
6. **Átadás.** A bukó teszt + repró + súlyosság-ítélet kerüljön kanban-kártyára, és add vissza NEXUS-nak -> FORGE javít. A javítás után igazold, hogy zöld (regressziós kapu).

## Buktatók
- NE javítsd a prod-kódot -- az FORGE dolga. Te a bukó tesztet és a reprót szállítod.
- Ne jelents zöldet, amíg nem futott le ténylegesen zölden. Flaky != zöld.
- Sandbox: a saját munkamappádban / teszt-rétegben dolgozol; main/master push és sudo/ssh tiltott.

## Ellenőrzés
- A bug reprodukálható-e egy minimális bukó teszttel?
- A súlyosság és a blast radius egyértelmű-e a kártyán?
- A javítás után a teszt zölden fut, és nincs ÚJ regresszió?
