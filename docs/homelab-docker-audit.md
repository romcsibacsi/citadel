# Homelab Docker-audit — READ-ONLY felmérés + STÁTUSZ-UI javaslat

> Készítette: **RELAY** (netops) — 2026-06-10 · Kanban #d0cc7c26
> Hatókör: **kizárólag olvasás** (docker ps/inspect/stats, compose-dir leltár). A homelabon
> **semmit nem indítottam újra, állítottam le, telepítettem vagy módosítottam.** Minden javítás
> az operátor döntése. Titkok (env/token/jelszó) a riportban **nincsenek** — a compose-ok érzékeny
> értékeit szándékosan nem olvastam.

Host: `uplinkserver` · Docker 28.1.1 · RAM 15.62 GiB · **71 konténer** (67 fut, 4 nem)

---

## 1. FÁZIS — LELTÁR

A konténerek compose-stack szerint csoportosítva. CPU/RAM = `docker stats --no-stream` pillanatkép.
Státusz-jelölés: ✅ fut · ⚠️ fut, de gond van · ⛔ nem fut (`Created`).

### Hálózat / ingress / DNS
| Konténer | Image (tag) | Mire való | Port(ok) | Státusz | Health | RP | RAM |
|---|---|---|---|---|---|---|---|
| nginx-proxy-manager-app-1 | jc21/nginx-proxy-manager:latest | Reverse-proxy ingress (publikus 80/443) | 80,81,443 →0.0.0.0 | ✅ | none | unless-stopped | 281M |
| cloudflared | cloudflare/cloudflared:latest | Cloudflare tunnel | — | ✅ | none | unless-stopped | 17M |
| adguard | adguard/adguardhome:latest | DNS + reklámszűrő | 53(LAN), 8093/8193 | ✅ | none | unless-stopped | 43M |

### VPN (⚠️ erős átfedés — lásd Diagnózis)
| Konténer | Image (tag) | Mire való | Port(ok) | Státusz | Health | RP | RAM |
|---|---|---|---|---|---|---|---|
| wireguard | linuxserver/wireguard | WireGuard VPN szerver | 51821/udp | ✅ | none | unless-stopped | 16M |
| wireguard-ui-wg | linuxserver/wireguard | WG (ui-hoz kötött) | 51820/udp | ✅ | none | unless-stopped | 14M |
| wireguard-ui | ngoduykhanh/wireguard-ui:latest | WG webes admin | 5000 (ütközik) | ⛔ Created | — | unless-stopped | — |
| wg-easy | weejewel/wg-easy | WG webes admin (másik) | 51822/51823 | ✅ | none | unless-stopped | 2M |
| wireguard-web-simple | nginx:alpine | Statikus WG-config oldal | 5000 →0.0.0.0 | ✅ | none | unless-stopped | 2M |

### Mail (mailcow stack — 21 konténer)
| Konténer | Image (tag) | Port(ok) | Státusz | Health | RP | RAM |
|---|---|---|---|---|---|---|
| ...nginx-mailcow | ghcr.io/mailcow/nginx:1.03 | 8180,8443 | ✅ | none | always | 3M |
| ...postfix-mailcow | ghcr.io/mailcow/postfix:1.80 | 25,465,587 | ✅ | none | always | 35M |
| ...dovecot-mailcow | ghcr.io/mailcow/dovecot:2.33 | 110,143,993,995,4190 | ✅ | none | always | 32M |
| ...rspamd-mailcow | ghcr.io/mailcow/rspamd:2.2 | — | ✅ | none | always | 327M |
| ...sogo-mailcow | ghcr.io/mailcow/sogo:1.133 | — | ✅ | none | always | 92M |
| ...mysql-mailcow | mariadb:10.11 | 127.0.0.1:13306 | ✅ | none | always | 126M |
| ...redis-mailcow | redis:7.4.2-alpine | 127.0.0.1:7654 | ✅ | none | always | 11M |
| ...clamd-mailcow | ghcr.io/mailcow/clamd:1.70 | — | ✅ | healthy | always | **1017M** |
| ...unbound-mailcow | ghcr.io/mailcow/unbound:1.24 | 53(belső) | ✅ | healthy | always | 17M |
| ...php-fpm / acme / olefy / netfilter / memcached / ofelia / dockerapi / watchdog / ipv6nat | ghcr.io/mailcow/* | belső | ✅ | (watchdog RC=1) | always | <70M each |

### Media / *arr
| Konténer | Image (tag) | Mire való | Port(ok) | Státusz | RP | RAM |
|---|---|---|---|---|---|---|
| plex | linuxserver/plex | Media szerver | host-net | ✅ | unless-stopped | 44M |
| serviio | lsiocommunity/serviio | DLNA szerver | 1900,8895,23423-4 | ✅ ⚠️**2019-es image** | unless-stopped | 217M |
| radarr | linuxserver/radarr:latest | Film-automatika | 7878 | ✅ | unless-stopped | 106M |
| sonarr | linuxserver/sonarr:latest | Sorozat-automatika | 8989 | ✅ | unless-stopped | 175M |
| prowlarr | linuxserver/prowlarr:latest | Indexer-proxy | 9696 | ✅ | unless-stopped | 84M |
| qbittorrent | linuxserver/qbittorrent:latest | Torrent | 6881, **8080→0.0.0.0** | ✅ | unless-stopped | 25M |
| overseerr | linuxserver/overseerr:latest | Media-kérés | 5055 | ✅ | unless-stopped | 221M |
| metube | ghcr.io/alexta69/metube:latest | YouTube-letöltő | 8101(LAN) | ✅ | unless-stopped | 71M |
| navidrome | deluan/navidrome:latest | Zene-streaming | 8094 | ✅ | unless-stopped | 31M |

### Produktivitás / dokumentum / web
| Konténer | Image (tag) | Mire való | Port | Státusz | RP | RAM |
|---|---|---|---|---|---|---|
| nextcloud-cron | nextcloud:33-apache | NC háttér-cron | 80(belső) | ✅ | unless-stopped | 9M |
| nextcloud(app) | nextcloud:33-apache | **NC web app** | — | ⛔ **Created (DOWN)** | unless-stopped | — |
| nextcloud-db | mariadb:11.4 | NC DB | 3306 | ✅ healthy | unless-stopped | 24M |
| nextcloud-redis | redis:7-alpine | NC cache | 6379 | ✅ healthy | unless-stopped | 3M |
| paperless-webserver | paperless-ngx-webserver | Dokumentum-kezelő | 8050 | ✅ healthy | unless-stopped | 270M |
| paperless-db | postgres:15 | Paperless DB | 5432 | ✅ | unless-stopped | 17M |
| paperless-broker | redis:7 | Paperless queue | 6379 | ✅ | unless-stopped | 4M |
| stirling-pdf | stirlingtools/stirling-pdf:latest | PDF-eszközök | — | ⛔ **Created (DOWN)** | unless-stopped | — |
| obsidian | linuxserver/obsidian:v1.8.10-ls73 | Obsidian web | 8070/8071 | ✅ | unless-stopped | 43M |
| dokuwiki | linuxserver/dokuwiki:latest | Wiki | 7000 | ✅ | unless-stopped | 29M |
| filebrowser | filebrowser/filebrowser:latest | Fájl-böngésző | 8075 | ✅ healthy | unless-stopped | 14M |
| vaultwarden | vaultwarden/server:latest | Jelszókezelő | 8091 | ✅ healthy | unless-stopped | 9M |
| forgejo | codeberg.org/forgejo/forgejo:12 | Git szerver | 2222,8092 | ✅ | unless-stopped | 124M |
| it-tools | ghcr.io/corentinth/it-tools:latest | Fejlesztői eszközök | 8098 | ✅ | unless-stopped | 2M |
| code-server | codercom/code-server:latest | Webes VS Code | **8444→0.0.0.0** | ✅ | unless-stopped | 7M |

### Web-oldalak (saját projektek)
| Konténer | Image (tag) | Mire való | Port | Státusz | RP | RAM |
|---|---|---|---|---|---|---|
| cryptohungary-site | wordpress:latest | WordPress oldal | 8300 | ✅ | unless-stopped | 106M |
| cryptohungary-db | mariadb:latest | WP DB | 3306 | ✅ | unless-stopped | 16M |
| hivelink-app | node:25-trixie-slim | Node app | 8200 | ✅ | unless-stopped | 27M |
| hivelink-nginx | nginx:alpine | Hivelink proxy | 8202 | ✅ | unless-stopped | 1M |
| hivelink-static | nginx:alpine | Hivelink statikus | 8200 (ütközik) | ⛔ Created | unless-stopped | — |
| kormany-site | nginx:alpine | Statikus oldal | 8100 | ✅ | unless-stopped | 2M |

### Smart-home / infra / tooling
| Konténer | Image (tag) | Mire való | Port | Státusz | RP | RAM |
|---|---|---|---|---|---|---|
| homeassistant | home-assistant:stable | Otthon-automatizálás | host-net | ✅ | unless-stopped | **1.77G** |
| go2rtc | alexxit/go2rtc:latest | Kamera-stream relay | host-net | ✅ | unless-stopped | 4M |
| ipfs | ipfs/kubo:latest | IPFS node | 4001,5001,8090 | ✅ healthy | unless-stopped | 285M |
| n8n | n8nio/n8n:latest | Workflow-automatizálás | 8096 | ✅ | unless-stopped | 320M |
| ntfy | binwiederhier/ntfy:latest | Push-értesítés | 8097 | ✅ healthy | unless-stopped | 15M |
| portainer | portainer/portainer-ce:latest | Docker-admin UI | 9000 | ✅ | unless-stopped | 30M |
| dashy | lissy93/dashy:latest | Launcher dashboard | 4000 | ✅ healthy | unless-stopped | 82M |
| watchtower | containrrr/watchtower:latest | Auto image-update | 8080(belső) | ✅ healthy ⚠️**archivált projekt** | unless-stopped | 13M |
| wud | getwud/wud:latest | Image-update monitor | 8099 | ✅ healthy | unless-stopped | 210M |
| librenms-db | mariadb:10.5 | LibreNMS DB (app hiányzik?) | 3306 | ✅ | always | 2M |
| test-proxy | nginx:alpine | **teszt-maradék** | 8400 | ✅ ⚠️ | **no** | <1M |
| mcp-workspace / mcp-filesystem / mcp-mcpvault / mcp-smart-connections | mcp-* (helyi build) | MCP szerverek | 8076-8079 | ✅ | unless-stopped | 8-66M |

---

## 2. FÁZIS — DIAGNÓZIS (priorizálva)

### 🔴 P1 — Most nem működik / leállt szolgáltatás
1. **Nextcloud web app DOWN** — a `nextcloud` app-konténer `Created` állapotban ragadt (ExitCode 0,
   sosem indult el), miközben a `nextcloud-db`/`-redis`/`-cron` fut. A Nextcloud webfelület
   gyakorlatilag nem elérhető. → Tisztázni: szándékos visszavonás, vagy elakadt indítás? Ha kell,
   `docker compose up -d` a `/home/uplinkfather/docker/nextcloud`-ban (operátori jóváhagyással).
2. **stirling-pdf DOWN** — `Created`, sosem indult. Ugyanaz a kérdés: kell-e még? Indítás vagy
   eltávolítás.

### 🟠 P2 — Orphan / név-ütközéses konténerek (gyors takarítás)
3. **2 db `<hex>_` prefixű zombi konténer** név-ütközés miatt: `19d74c94670f_stirling-pdf`,
   `d83302ea6381_nextcloud`. A hex-prefix azt jelzi, hogy a compose új konténert akart létrehozni,
   de a régi név foglalt volt. Ezek halott maradékok.
4. **Port-ütközésből `Created` konténerek:**
   - `wireguard-ui` → `Bind 0.0.0.0:5000 already allocated` (a `wireguard-web-simple` foglalja).
   - `hivelink-static` → `Bind 0.0.0.0:8200 already allocated` (a `hivelink-app` foglalja).
   Soha nem fognak elindulni a jelenlegi konfiggal — vagy port-csere, vagy törlés kell.
5. **test-proxy** — `nginx:alpine` a 8400-on, `restart=no` (egyetlen ilyen az egész hoston),
   láthatóan teszt-maradék. Reboot után sem jönne vissza. Eltávolítható.

### 🟡 P3 — Elavult / kockázatos image-ek
6. **serviio — 2019-es image** (≈7 év). Komoly elavultság; sok CVE valószínű. Frissítés
   (újabb DLNA megoldás) vagy leállítás.
7. **wg-easy — 2022-es `weejewel/wg-easy`** image; a projekt átköltözött `ghcr.io/wg-easy/wg-easy`-re.
   Elavult, és átfed a többi WireGuard-megoldással.
8. **watchtower — 2023-as image, a projekt archivált/karbantartatlan.** Ráadásul **redundáns**: a
   `wud` (Wud) ugyanazt a szerepet tölti be modernebbül. Egy auto-updaternél maradni érdemes.
9. **VPN-burjánzás:** 5 átfedő WireGuard-konténer (`wireguard`, `wireguard-ui`+`-ui-wg`, `wg-easy`,
   `wireguard-web-simple`) — ebből 2 admin-UI ugyanarra a célra, 1 halott. Konszolidáció **egy**
   megoldásra (javaslat: `wg-easy` friss ghcr-image, vagy `wireguard` + 1 UI) jelentősen
   egyszerűsítené és csökkentené a támadási felületet.

### 🟡 P4 — Biztonsági szag
10. **`:latest` tag szinte mindenhol** — nem reprodukálható, ellenőrizetlen frissülés. A *arr-stack,
    nginx-proxy-manager, vaultwarden, wordpress stb. mind `:latest`. Javaslat: kritikus
    szolgáltatásoknál verzió-pin (a forgejo `:12`, obsidian `:v1.8.10` jó példa).
11. **Szinte minden konténer root-ként fut** (User=root). A linuxserver-image-ek (`radarr`, `sonarr`,
    `qbittorrent`, `plex`, `prowlarr`...) támogatják a `PUID`/`PGID`-t — érdemes nem-root UID-re
    állítani. A `cloudflared` (65532), `n8n` (node), `navidrome`/`filebrowser` (1000) jó példák.
12. **0.0.0.0-ra kötött érzékeny portok** — `code-server:8444` (webes shell/IDE!), `qbittorrent:8080`,
    `portainer:9000` minden interfészen hallgat. LAN-on belül talán OK, de a `code-server` és
    `portainer` legalább reverse-proxy + auth mögé / LAN-IP-re kötése ajánlott. (A tényleges
    kitettség a host-tűzfaltól függ — ezt nem módosítottam, csak jelzem.)
13. **Hiányzó healthcheck** — a 67 futó konténerből csak ~12-nek van health-je. A kritikus
    szolgáltatásokra (NPM, mailcow-postfix/dovecot, vaultwarden már OK, *arr) healthcheck +
    auto-restart sokat javítana a megfigyelhetőségen.

### Erőforrás-összkép
A host összterhelése **alacsony** (CPU jellemzően <1%/konténer). RAM-zabálók: `homeassistant`
1.77G, `clamd` (mailcow vírusszkenner) 1.0G, `n8n` 320M, `rspamd` 327M, `ipfs` 285M. A többi
többnyire <100M. **Nincs erőforrás-szűk keresztmetszet** — az optimalizálás itt a *rendrakásról* és
*biztonságról* szól, nem a teljesítményről.

### Gyors nyeremény vs. nagyobb meló
| Akció | Erőfeszítés | Haszon |
|---|---|---|
| `test-proxy` + 4 `Created` zombi takarítása | gyors | tiszta `docker ps`, kevesebb zaj |
| watchtower **vagy** wud — egy updaterre | gyors | -1 archivált projekt, kevesebb confusion |
| Nextcloud/stirling: dönteni (indít/töröl) | gyors | nincs „fél-lábon álló" stack |
| VPN konszolidáció egy megoldásra | közepes | kisebb támadási felület, átláthatóság |
| serviio + wg-easy elavult image csere | közepes | CVE-kitettség csökken |
| PUID/PGID nem-root migráció (*arr) | nagyobb | jelentős biztonsági nyereség |
| Healthcheck + verzió-pin kritikus stackekre | nagyobb | reprodukálhatóság, megfigyelhetőség |

---

## 3. FÁZIS — STÁTUSZ-UI JAVASLAT (Dashy mellé/helyett)

A **Dashy** *launcher* (linkgyűjtemény), nem élő státusz-monitor. Az „él-e, egészséges-e,
mennyit eszik" kérdésre nem válaszol. Összevetés (mind self-hosted, ingyenes):

| Eszköz | Mi ez | Pró | Kontra | Erőforrás |
|---|---|---|---|---|
| **Beszel** | Könnyű szerver+konténer monitor (agent+hub) | Pici, gyönyörű, CPU/RAM/háló/disk **history**, konténer-szintű stat, riasztás | Nem „docker-management", csak monitor | ~50–80M |
| **Homepage** (gethomepage) | Modern dashboard + **élő** widgetek | Dashy-utód: docker-integráció (státusz/stat), 100+ service-widget (radarr, NPM stb.), gyönyörű, YAML-config | Konfig YAML-ban (nincs GUI-szerkesztő); widgetekhez API-kulcs kell | ~80–120M |
| **Dockge** | Compose-stack manager (a Dashy szerzőtárs ökoszisztéma) | Letisztult compose-szerkesztő+indító, élő log, stack-státusz | Csak compose-stackekhez (a sok „kézi" konténert nem kezeli jól); kevés metrika | ~60M |
| **Portainer** | Teljes Docker-management (**MÁR FUT** :9000) | Mindent tud: konténer/stack/volume/háló kezelés, stat, log, konzol | Nehézkes mint „státusz-glance"; admin-súlyú; root-Docker-socket = nagy jogkör | ~30M (megvan) |
| **Uptime Kuma** | Uptime/elérhetőség-monitor (HTTP/TCP/ping) | Kiváló „fent van-e + értesíts ha leesik", szép státusz-oldal, ntfy-integráció (már megvan!) | Nem konténer-metrika, hanem végpont-próba; manuálisan kell felvenni a monitorokat | ~100M |
| **Saját** (CITADEL dashboard integráció) | A meglévő dashboardba egy „Homelab" panel (`docker stats`/`inspect` JSON) | Egyetlen felület, teljes kontroll, a token-védett API-ba illik | Fejlesztői meló, karbantartás nálunk | — |

### AJÁNLÁS
Két réteg, kiegészítik egymást — **ne** telepíts mindent:

1. **Élő státusz + metrika: Beszel** — a legjobb ár/érték „mi fut, mennyit eszik, volt-e gond"
   kérdésre. Pici, történeti grafikon, beépített riasztás. Ez adja azt, amit a Dashy **nem**.
2. **Elérhetőség + értesítés: Uptime Kuma** — mert már megvan az **ntfy** (8097): leesik egy
   szolgáltatás → push a telefonra. Kis befektetés, nagy nyugalom.
3. A **Dashy marad** launchernek; a **Portainer** (már fut) marad a ritka „kézi management"-re.
4. Hosszabb távon, ha integrált egyfelületet akarsz: a **saját CITADEL-dashboard „Homelab" panel**
   a `docker stats --no-stream` + `inspect` JSON-ból — de ez fejlesztői kártya (FORGE), nem netops.

> Megjegyzés: a *Homepage* önmagában is jó „Dashy-csere, élő widgetekkel" út, ha **egy** szebb
> felületet akarsz a sok helyett. Ízlés/irány-döntés → operátoré. **Semmit nem telepítettem.**

---

## Ellenőrzés / rollback
Nincs mit visszagörgetni: a felmérés **kizárólag olvasás** volt (`docker ps/inspect/stats`,
compose-könyvtár-leltár). A homelab állapota változatlan. Minden javasolt akció külön operátori
jóváhagyást igényel.
