# Autonóm homelab-watchdog — megoldás-TERV (recovery + frissítés)

> RELAY (netops) — 2026-06-10 · Kanban #55c4fa1c (B rész) · **PROPOSAL** — NEXUS-nak.
> Ez TERV, nem implementáció; semmilyen scheduled-taskot nem építettem, futó configot nem módosítottam.
> **Frissítve az operátori döntésekkel** (2026-06-10): determinisztikus recovery (nincs AI-poll) +
> full-auto frissítés **teszt-kapuval**. Jóváhagyás után **FORGE** építi; RELAY adja a homelab-specifikus
> health/recovery parancsokat, az allowlistát és a teszt-definíciókat.

---

## 1) Leesett konténer visszahozása — DETERMINISZTIKUS, nem AI-figyelés

> Operátori elv: *„Nem kell AI a dockerek figyeléséhez — elég akkor lépni, ha szükséges."*
> Tehát: nincs folyamatos AI-poll-loop. A figyelés/recovery sima, determinisztikus gépezet; az AI/csapat
> **csak az eszkalációnál** lép be.

**Háromrétegű, az olcsóbbtól a drágábbig:**

1. **Alapréteg — Docker SAJÁT restart-policy + healthcheck (már létezik, AI nélkül).**
   A konténerek többsége `unless-stopped`/`always` → az összeomlót a Docker magától visszahozza. A
   healthcheck jelzi az `unhealthy` állapotot. Ez kezeli a leesések többségét, **nulla AI**.
2. **Könnyű watchdog — determinisztikus cron-script VAGY Uptime Kuma → webhook.**
   - *Cron-script:* pár percenként `docker ps`/`inspect`; ami **tartósan** `down`/`unhealthy` ÉS a
     „managed" allowliston van → `docker start` / `compose up -d`. Sima bash/Python, **nincs AI**.
   - *Vagy Uptime Kuma → webhook:* a most telepített Uptime Kuma down-eseménynél meghív egy
     CITADEL recovery-endpointot, ami ugyanazt a `start`/`up`-ot futtatja. Előny: az észlelést az Uptime
     Kuma adja, nem kell saját polling.
3. **Eszkaláció — csak itt lép be a csapat/operátor.**
   Ha **N próbára SEM** jön fel (pl. crash-loop, konfighiba) → a script **abbahagyja** és **pingel**
   (ntfy/Telegram). Az AI/RELAY ekkor diagnosztizál — nem előbb. Minden recovery-t jelent a csatornára.

**Korlát (fontos):** a watchdog SOSEM indít el szándékosan leállítottat (`.disabled` stackek, vagy a
`restart=no`-ra tett dolgok) — csak az explicit **managed-allowlistre** hat. Csak `start`/`up`, sosem
adatvesztéses recreate.

**Gyors higiénia:** a „kell, hogy fusson" konténereknél a `restart: unless-stopped` egységesítése, hogy
az 1. réteg minél többet elvigyen.

---

## 2) Docker-frissítés — FULL AUTO, teszt-kapuval

> Operátori döntés: *„Ha megfelelő tesztek vannak, mehet full auto."* → **teljesen autonóm frissítés,
> de a TESZT a kapu** (nincs per-update emberi gomb; a teszt véd helyette).

**A pipeline (a `docs/homelab-update-strategy.md`-re építve):**

```
wud észlel új verziót (ntfy)
   → /config-backup (a host bind-dir tar-ja)        ← visszaállás biztosítva
   → verzió-PIN az új tagre a compose-ban
   → docker compose pull + up -d (egyenként)
   → POST-UPDATE TESZT (smoke/health, lásd mátrix)
        ├─ PASS → marad, jelentés a csatornára ("frissítve X→Y, teszt zöld")
        └─ FAIL → AUTO-ROLLBACK az előző tagre + /config visszaállítás, jelentés ("rollback, teszt bukott")
```

A **teszt a feltétel**: full-auto CSAK ott megy, ahol van értelmes, gépi post-update teszt, ami elkapja,
ha a frissítés funkcionálisan tört (akkor is, ha a konténer „fut és healthy"). Ahol nincs ilyen teszt →
**notify-then-manual** marad (a csapat előkészít + jelez, az operátor dönt).

### Milyen teszt kell — konténerenként/kategóriánként (a full-auto feltétele)

| Kategória / konténer | Post-update teszt | Mód |
|---|---|---|
| **Statikus web** (kormany-site, hivelink-nginx, cryptohungary-site) | HTTP 200 a webrooton | ✅ FULL AUTO |
| **Egyszerű web-app** (it-tools, dashy, filebrowser, navidrome, metube, ntfy, obsidian, dokuwiki) | HTTP 200/302 a fő URL-en | ✅ FULL AUTO |
| **\*arr stack** (radarr, sonarr, prowlarr) | `GET /ping` → 200 **+** API él a kulccsal **+** a kapcsolat-teszt (Prowlarr→\*arr, \*arr→qBittorrent „Test" API zöld) | ✅ FULL AUTO (gazdag smoke) |
| **qBittorrent** | WebUI 200 (8080) + `GET /api/v2/app/version` válaszol | ✅ FULL AUTO |
| **overseerr** | `GET /api/v1/status` → 200 | ✅ FULL AUTO |
| **plex** | `GET /identity` → 200 | ✅ FULL AUTO |
| **monitoring/util** (beszel, uptime-kuma, wud, portainer, forgejo, n8n) | HTTP 200 a UI-n (n8n/forgejo: + DB-kapcsolat él) | ✅ FULL AUTO (n8n/forgejo: minor; major → manual) |
| **vaultwarden** | `GET /alive` → 200 + healthy | ✅ FULL AUTO (patch); major → manual |
| **adguard** | `/control/status` JSON OK **+** valódi DNS-feloldás teszt (`dig @127.0.0.1`) | ✅ FULL AUTO, de KRITIKUS (DNS) — szoros teszt |
| **nginx-proxy-manager** | admin :81 200 **+** egy ismert proxyzott site 200/301 (az ingress tényleg proxyz-e) | ⚠️ FULL AUTO csak erős teszttel (ez az ingress) |
| **Adatbázisok** (mariadb, postgres, redis — *arr/nextcloud/mailcow/cryptohungary DB-k) | healthcheck zöld **+** a függő app még csatlakozik | ⚠️ patch=auto; **MAJOR verzió = MANUAL** (adatformátum-migráció) |
| **Nextcloud** | `/status.php` → `{"installed":true,...}` | ⚠️ minor=auto; **major = MANUAL** (occ upgrade lépések) |
| **Home Assistant** | `/` → 200 (+ ideálisan API token-nel) | ⚠️ NOTIFY-THEN-MANUAL (integrációk törhetnek, saját frissítési út ajánlott) |
| **mailcow (21 konténer)** | — | ⛔ **KIVÉTEL: NE ezzel a pipeline-nal.** A mailcow-nak SAJÁT `update.sh`-ja van; az egyetlen biztonságos út. notify → operátor futtatja a mailcow updatert |

**Olvasat:** a homelab nagy része (statikus oldalak, egyszerű web-appok, a teljes \*arr lánc, plex,
overseerr, monitoring) **full-auto-képes** jó teszttel. A **kockázatos kisebbség** — adatbázis-MAJOR,
Nextcloud-major, Home Assistant, és kiemelten a **mailcow** — marad notify-then-manual, mert ott nincs
egyszerű smoke-teszt, ami elkapná az adat-/integrációs törést.

---

## Összefoglaló — mit építsen FORGE (jóváhagyás után)
1. **Recovery:** determinisztikus watchdog (cron-script vagy Uptime-Kuma-webhook) → `start`/`up` a
   managed-allowlistre → N próba után eszkaláció + jelentés. **Nincs AI-poll**; az AI csak eszkalációnál.
2. **Frissítés:** wud-triggerelt, teszt-kapus full-auto update-script: backup → pin → pull+recreate →
   post-update teszt → PASS marad / FAIL auto-rollback → mindig jelent. A **teszt-mátrix** szerint;
   ahol nincs értelmes teszt (DB-major, Nextcloud-major, HA, **mailcow**) → notify-then-manual.
3. RELAY szállítja: a managed-allowlistát, a per-konténer health/recovery parancsokat és a post-update
   teszt-parancsokat (a fenti mátrix konkrét curl/health hívásai).
