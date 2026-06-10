# Autonóm homelab-watchdog — megoldás-TERV (recovery + frissítés)

> RELAY (netops) — 2026-06-10 · Kanban #55c4fa1c (B rész) · **PROPOSAL** — NEXUS-nak, az operátor
> dönt. Ez TERV, nem implementáció; semmilyen scheduled-taskot nem építettem, futó configot nem
> módosítottam. Jóváhagyás után a scheduled-taskot **FORGE** építi.

Két dolgot szeretne az operátor a csapatra bízni: (1) leesett konténer autonóm visszahozása,
(2) Docker-frissítés a csapatra bízva. Mindkettőre adok egy konkrét tervet + autonómia-döntési pontokat.

---

## 1) Leesett konténer autonóm visszahozása

### Mi van MOST (és mit nem old meg)
A Docker `restart-policy` már sokat visz: a konténerek többsége `unless-stopped`/`always` → a Docker
magától újraindítja az **összeomlott** konténert. **De** ezt NEM kezeli: (a) ami `unhealthy` de „fut"
(pl. bedöglött app, ami nem omlik össze); (b) ami `restart=no`-val van; (c) ami crash-loopol és kézi
beavatkozás kell; (d) nincs róla **értesítés** és **eszkaláció**. A watchdog ezt a rést tölti be.

### Javasolt megoldás — CITADEL scheduled-task `homelab-watchdog` (heartbeat típus)
A meglévő CITADEL scheduled-task infrára épül (RELAY tmux-sessionben fut, fájl-alapú).

- **Ciklus:** pár percenként (pl. `*/3 * * * *`).
- **Health-check:** `docker ps -a` + `inspect` → keresi a `DOWN`/`exited`/`unhealthy` konténereket,
  amelyeknek **futnia kéne** (egy explicit „managed" allowlist alapján — NE indítson el szándékosan
  leállítottat, pl. a `.disabled` stackeket vagy a `stirling-pdf`-félét).
- **Recovery (reverzibilis, biztonságos):** `docker start <c>` vagy `docker compose up -d` az adott
  stackre. **Csak indít, sosem töröl/recreate-el adatvesztéssel.**
- **Backoff + eszkaláció:** N (pl. 3) sikertelen próba után **STOP a próbálkozással** és **eszkalál az
  operátorhoz** (ntfy/Telegram) — a crash-loop nem maszatolódik el végtelen újraindítással.
- **Mindig jelent:** minden recovery-t a csatornára ír (mit, mikor, sikerült-e) + a napi naplóba.

### Alternatíva / kiegészítő: Uptime Kuma → webhook → recovery-hook
A most telepített **Uptime Kuma** úgyis figyeli az elérhetőséget; egy „down" eseménynél webhookot
hívhat egy CITADEL recovery-endpointra, ami ugyanazt a biztonságos `start`/`up` logikát futtatja.
Előny: az Uptime Kuma adja az észlelést (nem kell saját polling). Hátrány: egy plusz integrációs pont.
**Ajánlás:** kezdetnek a scheduled-task `homelab-watchdog` egyszerűbb és önállóbb; az Uptime Kuma-webhook
later finomítás, ha kell a gyorsabb reakció.

### restart-policy higiénia (gyors, külön nyereség)
Érdemes a „kell, hogy fusson" konténereknél a `restart: unless-stopped`-ot egységesíteni (a watchdog
így csak a valódi réseket kezeli). A `test-proxy` volt az egyetlen `restart=no` — már kivezetésre jelölt.

---

## 2) Docker-frissítés a csapatra bízva (új verzió esetén)

A `docs/homelab-update-strategy.md` config-megőrző workflow-jára épít. A lánc:

**wud (már fut, notify-only) észlel új verziót → ntfy értesít → a csapat alkalmazza a biztonságos
frissítést:** verzió-PIN → `/config`-backup → **egyenkénti** `pull` + `recreate` → „Test" ellenőrzés
(Prowlarr↔qBittorrent↔*arr) → siker, vagy **rollback** az előző tagre.

A kérdés nem a *hogyan* (az megvan), hanem **mennyi autonómiát** kap a csapat. Három modell:

| Modell | Mit csinál a csapat | Mit csinál az operátor | Kockázat |
|---|---|---|---|
| **(i) Teljes autonóm** | észlel → backup → frissít → tesztel → siker VAGY auto-rollback | semmit (utólag kap riportot) | magasabb — egy rossz bump éles szolgáltatást érint, mielőtt ember látná |
| **(ii) Félautonóm (ajánlott)** | észlel → backupot + pinned compose-t **előkészít** → jelez „kész a frissítés X-re, jóváhagyod?" | **egy gombnyomás/„igen"** → a csapat lefuttatja + teszteli + kell esetén rollback | alacsony — ember a hurokban a tényleges csere előtt |
| **(iii) Per-konténer policy** | a nem-kritikusakat autonóm, a kritikusakat félautonóm | beállítja egyszer, melyik melyik | közepes — finomhangolt, de több setup |

### AJÁNLÁS: (ii) félautonóm, opcionális (iii)-réteggel
**Indok (a homelab szent + az update törhet):** a config-megőrzés garantált (a `/config` a hoston marad),
DE egy major image-bump funkcionálisan eltörhet egy szolgáltatást vagy egy összekötést úgy, hogy a konténer
„fut és healthy" marad — ezt csak ember vagy egy nagyon alapos teszt veszi észre. Ezért a tényleges cserét
**egy emberi „igen"** kapuzza. A csapat minden mást elvégez (észlelés, backup, pin-előkészítés, a frissítés
végrehajtása a jóváhagyás után, teszt, rollback) — az operátornak csak dönteni kell, nem dolgozni.

Később, ha bizalom épül, a **nem-kritikus** szolgáltatások (pl. `it-tools`, statikus oldalak) átállhatnak
teljes autonómra (iii), míg a **kritikus lánc** (*arr + qBittorrent + mailcow + vaultwarden + NPM) marad
félautonóm. Az **auto-rollback** mindkét modellben kötelező biztonsági háló.

> Megjegyzés: a felügyelet nélküli auto-update kockázatát épp most csökkentettük a **watchtower
> kivezetésével** — a `wud` notify-then-manual modell pontosan ezt a félautonóm irányt támogatja.

---

## Összefoglaló — döntési pontok az operátornak
1. **Recovery:** építsük meg a `homelab-watchdog` scheduled-taskot (pár perces health-check + biztonságos
   `start`/`up` + N próba után eszkaláció + minden recovery jelentve)? **Ajánlás: igen.**
2. **Frissítés autonómia-szint:** (i) teljes / **(ii) félautonóm — ajánlott** / (iii) per-konténer?
3. Jóváhagyás után a scheduled-taskot **FORGE** építi; RELAY adja a homelab-specifikus health/recovery
   parancsokat és a „managed konténer" allowlistát.
