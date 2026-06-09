---
name: team-sync
description: Napi csapat-szinkron — az aznapi munkából (napi naplók + kanban) kivonja, KI MIT csinált és miben jó/megbízhatatlan, és ezt MEGOSZTOTT (shared) memóriába írja, hogy az egész flotta tudjon egymásról. A megosztott memória feltöltője.
---

Te most a **Team Sync**-et futtatod CITADEL alatt (~23:50, a nap végén). Az operátorod alszik — **NE küldj üzenetet semmilyen csatornára.** A kimeneted: 3-5 **megosztott (`category=shared`) memória** a csapatról. Munkakönyvtár: `/home/uplinkfather/CITADEL/citadel`. Token: `store/.dashboard-token`.

Cél: a megosztott memória most üres, így az ügynökök nem tudnak tapasztalatból egymásról („ki ért X-hez"). Te ezt töltöd fel az aznapi valós munkából.

## 1. Olvasd be az aznapi csapat-aktivitást
```bash
BASE=http://localhost:3420; AUTH="Authorization: Bearer $(cat store/.dashboard-token)"
# per-agent napi napló:
for a in nexus forge spark sigma relay screener oracle creative argus; do
  echo "== $a =="; curl -s -H "$AUTH" "$BASE/api/daily-log?agent=$a"
done
# kanban (ki mit zárt le / min dolgozik):
curl -s -H "$AUTH" "$BASE/api/kanban"
# meglévő megosztott memóriák (DEDUP-hoz, hogy ne írd ugyanazt kétszer):
curl -s -H "$AUTH" "$BASE/api/memories?category=shared&limit=50"
```

## 2. Vonj le 3-5 cross-agent megfigyelést
Olyan tartós, csapat-szintű tudás, ami MÁS ügynöknek is hasznos — pl.:
- „FORGE: a build/typecheck-es feladatok megbízható gazdája." 
- „MUSE helyi kép-gen megbízhatatlan (tool-hiba) → kép-feladat CREATIVE-nak."
- „ARGUS: külső YouTube-videó összefoglalás (átirat + képkockák)."
- delegálási minták, visszatérő buktatók, kinek mi a hatóköre.

NE írj triviálisat vagy egynapos zajt. Csak ami legközelebb is igaz lesz.

## 3. Írd megosztott memóriába (dedup után)
Minden megfigyelést — ha még NINCS benne (1. pont shared-lista) — ments:
```bash
curl -s -X POST http://localhost:3420/api/memories -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"agent_id":"nexus","content":"A MEGFIGYELÉS","category":"shared","keywords":"team, <érintett-agent>"}'
```

## 4. Zárás
- NINCS csatorna-üzenet. Az eredményed a megosztott memóriák.
- Felső korlát: **max 5** új megosztott memória / nap (a zaj ellen).
- Ha aznap nem volt érdemi csapat-aktivitás, ne írj semmit.

## Buktatók
- Dedup kötelező (a `category=shared` listából) — különben minden este ugyanazt írnád.
- A megosztott memóriát MINDEN ügynök látja (a kereső uniózza `category='shared'`) — csak tényleg közérdekű tudás kerüljön ide.

## Ellenőrzés
- `GET /api/memories?category=shared` mutatja az új bejegyzéseket, nap végén 0-5 új sorral.
