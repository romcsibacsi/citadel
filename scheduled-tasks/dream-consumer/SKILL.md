---
name: dream-consumer
description: A Dream Engine éjszakai javaslatait VÉGREHAJTja — a megvalósítható skill-javaslatokból tényleg skillt gyárt/patch-el, az operátort érintő javaslatokat pedig az ötletládába (idea_box) teszi. Lezárja a tanuló-kört (javaslat → valódi skill / ötlet).
---

Te most a **Dream Consumer**-t futtatod CITADEL alatt (~02:30, közvetlenül a Dream Engine után). Az operátorod alszik — **NE küldj üzenetet semmilyen csatornára.** A kimeneted: új/patch-elt skillek a `~/.claude/skills/`-ben + bejegyzések az ötletládában. Munkakönyvtár: `/home/uplinkfather/CITADEL/citadel`. Token: `store/.dashboard-token`.

A Dream Engine javasol, de magától nem hajt végre semmit. A te dolgod: a `store/DREAM.md` éjszakai javaslataiból ami **megvalósítható skill**, abból csinálj skillt; ami **az operátornak szóló döntés/ötlet**, az menjen az ötletládába.

## 1. Olvasd be a DREAM.md-t
```bash
cat /home/uplinkfather/CITADEL/citadel/store/DREAM.md 2>/dev/null || { echo "nincs DREAM.md — kilépek"; exit 0; }
```
Releváns szekciók: `## 💡 Skill-/folyamat-javaslatok`, `## 🛠 Skill-flotta egészség`, `## 🌐 Külső lehetőség`.

## 2. Skill-javaslatok → valódi skill (max 2 / éjszaka)
Minden „💡 Skill-/folyamat-javaslat"-nál döntsd el: **újrafelhasználható technika/eljárás**-e (akkor skill), vagy **egyszeri döntés/konfig** (akkor ötletláda, lásd 3. pont).

Ha skill-méltó:
1. **Dedup ELŐSZÖR** — nézd meg, van-e már hasonló (használd a `skill-management` skillt vagy egyszerűen):
   ```bash
   ls ~/.claude/skills/; grep -ril "<kulcsszó>" ~/.claude/skills/*/SKILL.md 2>/dev/null
   ```
   - Ha van hasonló → **PATCH-eld** (csak a változó részt, pl. a „Buktatók" szekciót bővítsd), ne hozz létre újat.
   - Ha nincs → hozz létre egyet:
   ```bash
   mkdir -p ~/.claude/skills/SKILL-NEV && cat > ~/.claude/skills/SKILL-NEV/SKILL.md << 'SKILLEOF'
   ---
   name: skill-nev
   description: Mikor használd + mit csinál (konkrét, "pushy" trigger).
   ---
   # Skill neve
   ## Mikor használd
   ## Eljárás
   ## Buktatók
   ## Ellenőrzés
   SKILLEOF
   ```
2. **Felső korlát: max 2 skill létrehozás/patch egy éjszaka** (a minőség > mennyiség; ne szemeteld tele a skill-mappát).
3. Ha létrehoztál/patch-eltél: frissítsd az indexet: `bash scripts/skill-index.sh`.

## 3. Operátornak szóló javaslatok → ötletláda (idea_box)
Ami NEM skill, hanem az operátornak szóló döntés/stratégia/konfig (pl. „MUSE-t routeold át CREATIVE-ra", egy `🌐 Külső lehetőség` repo-ajánlás, egy folyamat-rés): tedd az **ötletládába**, hogy reggel a dashboardon lássa és kanbanra emelhesse:
```bash
curl -s -X POST http://localhost:3420/api/ideas -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"title":"RÖVID CÍM","description":"1-2 mondat + miért","source":"dream-consumer","category":"Dream"}'
```
Ne duplikálj: ha ugyanaz az ötlet már bent van (`GET /api/ideas`), hagyd ki.

## 4. Zárás
- NINCS csatorna-üzenet (csendes éjszakai feladat). Az eredményed a skillek + az ötletláda.
- Ha semmi megvalósítható nem volt, ne csinálj semmit.

## Buktatók
- A DREAM.md éjjel felülíródik — csak az aznap éjszakai javaslatokkal dolgozz.
- Dedup kötelező a skilleknél (különben minden éjjel ugyanazt gyártanád).
- Védett skillekhez (`pinned: true`, gyári/plugin skillek) NE nyúlj.

## Ellenőrzés
- Legfeljebb 2 új/patch-elt skill, az index frissítve (`ls ~/.claude/skills/` mutatja).
- Az operátornak szóló javaslatok a `GET /api/ideas`-ban megjelennek.
