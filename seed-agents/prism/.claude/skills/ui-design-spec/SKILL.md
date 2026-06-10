---
name: ui-design-spec
description: Wireframe / UI mockup / design-rendszer spec készítése MARKDOWN + ASCII formában (draft-only). Akkor használd, amikor az operátor vagy NEXUS web/UI vizuális irányt, layoutot, wireframe-et, mockupot vagy design-rendszert kér. A kész spec NEXUS-on át FORGE-hoz megy megvalósításra.
---
# UI Design Spec (wireframe + design-rendszer, draft-only)

## Mikor használd
- Web/UI vizuális irány, layout, wireframe, mockup vagy design-rendszer kérése.
- A kimenet MARKDOWN + ASCII spec a saját munkamappádba; NEM kód, NEM generált kép.
- A kész specet NEXUS-on át FORGE valósítja meg (design->PRISM, build->FORGE).

## Eljárás
1. **Cél + kontextus.** Egy mondatban: ki a felhasználó, mi a feladata, mi a siker (a 3 mp-es első benyomás).
2. **Információs hierarchia.** Sorold fel a tartalmat fontossági sorrendben; ez vezeti a layoutot.
3. **Layout (ASCII wireframe).** Rajzold le ASCII-box-okkal a fő régiókat (header/nav/main/aside/footer), a kulcs-komponensek helyét és a reszponzív viselkedést (mobil/desktop).
4. **Design-tokenek.** Adj konkrét skálát: térköz (4/8/12/16/24/32...), tipográfia (méret/súly/sortáv), szín-szerep (bg/fg/primary/muted/danger) kontraszt-aránnyal, sugár/árnyék.
5. **Komponens-spec.** A kulcs-komponensekhez: állapotok (default/hover/focus/active/disabled), méretek, szöveg, ikon, és a11y (fókusz-gyűrű, ARIA, billentyű-navigáció, kontraszt >= WCAG AA).
6. **Átadás.** A specet a saját mappádba mented, kanban-kártyán láthatóvá teszed, és NEXUS-nak jelzed, hogy mehet FORGE-hoz megvalósításra.

## Buktatók
- NE írj kódot és NE generálj képet: a terméked spec és vizuális irány.
- Ne hagyd ki az állapotokat és az a11y-t (a fókusz/kontraszt nem opció).
- Konkrét értékek, ne „tegyél ide valami szépet": minden token legyen mérhető.

## Ellenőrzés
- A spec önmagában elég-e, hogy FORGE pixelpontosan, kérdés nélkül leépítse?
- Minden interaktív elemnek megvan-e minden állapota + a11y-ja?
- Konzisztens-e a térköz / tipográfia / szín skála végig?
