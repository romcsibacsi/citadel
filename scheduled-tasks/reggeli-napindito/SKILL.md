---
name: reggeli-napindito
description: Reggeli összefoglaló az operátornak a beállított élő csatornán — Dream Engine kivonat, plusz email/naptár/AI hírek ha elérhető.
---

Reggeli napindító CITADEL alatt. Az összefoglalót **a beállított élő csatornán** küldd ki az operátorodnak a saját csatorna-reply-tooloddal (jelenleg Discord; a célt a csatorna-konfig adja — ne hardcode-olj chat_id-t, a reply-toolod tudja a célt). Munkakönyvtár: `/home/uplinkfather/CITADEL/citadel`.

## 1. Dream Engine kivonat (a napindító ELEJÉRE)

A `store/DREAM.md` az éjszakai Dream Engine kimenete. Olvasd be és tedd az üzenet ELEJÉRE a kulcs-szekciókat:

```bash
cat /home/uplinkfather/CITADEL/citadel/store/DREAM.md 2>/dev/null || echo "(nincs DREAM.md — kihagyom)"
```

Emeld ki: `🧠 A csapat tegnapi munkája`, `💡 Skill-/folyamat-javaslatok`, `🎯 Holnapi top-3`, `🌐 Külső lehetőség`, `🛠 Skill-flotta egészség`. Ha a DREAM.md nem létezik vagy üres (a Dream Engine nem futott), **hagyd ki ezt a szekciót** és jelezd egy sorban: „(Dream Engine éjjel nem futott le.)".

## 2. Naptár / email / AI hírek (csak ha elérhető, csak NEXUS-nál)

- **📅 Naptár (ma)**: futtasd `node scripts/calendar-today.mjs` — a beállított Google-naptár mai, hátralévő eseményeit adja vissza (read-only, magát frissíti). Ha ad sorokat, tedd be egy „📅 Naptár" szekcióba; ha üres vagy hibára fut, **csendben hagyd ki**.
- **Email**: jelenleg nincs bekötve — hagyd ki. (Ha később lesz Gmail-integráció, ide kerül.)
- **🤖 AI hírek**: CSAK a fő-ágensként (NEXUS). Ha valamiért sub-agentként futnál, hagyd ki.

## 3. Formátum és csatorna

- A formázást a beállított csatornához igazítsd (Discord natív Markdown; ne Telegram-MarkdownV2-t escape-elj, hacsak a provider ténylegesen Telegram).
- Egy üzenet, tömör, olvasható. Sorrend: **Dream kivonat → email/naptár → AI hírek.**
- Ha SEMMI érdemi nincs (nincs DREAM.md, nincs email/naptár/hír), egy rövid „Jó reggelt — ma nincs kiemelt teendő." sor is elég.

Kizárólag a CITADEL roster (nexus, forge, spark, sigma, relay, screener, oracle) és a beállított élő csatorna — régi/upstream ágensnév vagy fix chat_id sehol.
