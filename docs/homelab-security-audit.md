# Homelab biztonsági audit — P4 (READ-ONLY)

> RELAY (netops) — 2026-06-11 · Kanban #ffb02422 · **READ-ONLY** — semmit nem módosítottam.
> A tényleges hardening külön, operátor-jóváhagyott kártyá(k)on megy. A homelab szent.

Hatókör: root-futás, `:latest`/nem-pinnelt image-ek, feleslegesen kitett (0.0.0.0) portok. Host: 67 futó konténer.

## 0. Kontextus (ami minden alábbit keretez)

- **A host-tűzfal INAKTÍV** (`ufw: inactive`, `iptables INPUT policy: ACCEPT`). Tehát **minden `0.0.0.0`-ra kötött port elérhető bármely LAN-eszközről, backstop nélkül**. Internet felé csak az NPM (80/443) + cloudflared-tunnel + a router explicit port-forwardjai jutnak ki — de egy kompromittált LAN-eszköz (IoT, telefon, vendég) bármit elér. **Ez a legnagyobb egyetlen hiányosság.**
- **Sok szolgáltatás MÁR jól áll** (korábbi munka): beszel/uptime-kuma/metube/adguard:53 LAN-bindelt; navidrome/dashy/filebrowser/n8n/vaultwarden/forgejo/uptime-kuma/beszel/nextcloud/paperless-db **pinnelve**; a DB-k (nextcloud-db, *-redis, mailcow-mysql) **nem** 0.0.0.0-n (belső).
- A linuxserver-image-ek (`radarr/sonarr/prowlarr/qbittorrent/plex/overseerr/dokuwiki/wireguard`) s6-initje rootként fut, de **az appot PUID=1000-re ejti** → ezeknél az alkalmazás NEM rootként fut (a „60/67 root" emiatt félrevezető).

## 1. PRIORITIZÁLT LELETEK

### 🔴 P1 — magas kockázat, gyors/közepes fix

| # | Konténer / terület | Szag | Javasolt fix | Kockázat / ráfordítás |
|---|---|---|---|---|
| 1 | **Host-tűzfal** | nincs (ufw inactive, iptables ACCEPT) — minden port nyitva LAN-ról | `ufw` bekapcsolás default-deny inbound + allow a szükséges LAN-portokra (NPM 80/443, wireguard 51821, mailcow 25/465/587/993..., adguard 53, SSH) | közepes ráfordítás; KÖRÜLTEKINTÉS: rossz szabály kizárhat — előbb allow-lista, csak utána enable, konzol-hozzáféréssel |
| 2 | **code-server :8444** (0.0.0.0) | webes IDE/**SHELL** az egész LAN-nak | LAN-bind (`192.168.1.105:8444`) VAGY NPM+auth mögé; erős jelszó | alacsony ráfordítás, magas nyereség |
| 3 | **portainer :9000** (0.0.0.0) | teljes Docker-management + **root docker.sock** | LAN-bind / NPM+auth; vagy csak akkor indítsd, ha kell | alacsony ráfordítás, magas nyereség |
| 4 | **mcp-* :8076-8079** (0.0.0.0) | filesystem/**vault** MCP sima HTTP-n minden interfészen (`mcp-mcpvault`, mcp-filesystem, mcp-workspace, mcp-smart-connections) | localhost- vagy LAN-bind; ezek belső MCP-k, nem kell 0.0.0.0 | alacsony ráfordítás, magas nyereség (főleg a vault) |
| 5 | **cryptohungary-db = `mariadb:latest`** | **adatbázis rolling `:latest`-en** → egy recreate major DB-t húzhat → adatformátum-törés | pin a jelenlegi majorra (`mariadb:11` v. a futó verzió) | alacsony ráfordítás |

### 🟠 P2 — közepes

| # | Konténer | Szag | Javasolt fix |
|---|---|---|---|
| 6 | **qbittorrent :8080** (0.0.0.0) | WebUI minden interfészen | LAN-bind / NPM+auth |
| 7 | **vaultwarden :8091** (0.0.0.0) | jelszókezelő (van saját auth, de defense-in-depth) | NPM+TLS mögé / LAN-bind |
| 8 | **cryptohungary-site `wordpress:latest`** | WordPress rolling latest-en | verzió-pin |
| 9 | **Fontos `:latest`-ek** | nginx-proxy-manager (`jc21/...:latest`), ipfs, adguard, wud, a *arr-lánc, dokuwiki, ntfy, metube, go2rtc, code-server, it-tools | verzió-pin a jelenlegi stabilra (a wud-tuning mintája) — kiszámítható frissítés, kevesebb meglepetés |

### 🟡 P3 — nagyobb meló / alacsonyabb prioritás

| # | Terület | Megjegyzés |
|---|---|---|
| 10 | **Root-futás migráció** | A linuxserver *arr-ek már PUID-re ejtenek (rendben). A VALÓDI root-app-ok (pl. saját buildek, wordpress, néhány tooling) nem-root UID-re állítása per-szolgáltatás teszteléssel — nagyobb meló, alacsonyabb hozam mint a tűzfal/port-bind. |
| 11 | **Bulk `:latest` pin** | a maradék nem-kritikus `:latest`-ek pinnelése — hygiene; a guard/wud-tuning már védi a full-auto kört. |
| 12 | **mcp-* HTTP titok-átvitel** | ha az MCP-k titkot visznek HTTP-n, fontold a localhost-only + TLS-t (a vault-modul már titkosítva tartja a kulcsokat). |

## 2. Mit NEM kell bántani (szándékos kitettség)

- **NPM 80/81/443**, **mailcow 25/465/587/110/143/993/995/8443**, **wireguard 51821/udp**, **adguard 53** — ezek a funkciójukhoz kellenek kitéve. (A tűzfal-szabály ezeket explicit allow-olja.)

## 3. Ajánlott sorrend (operátori kártyákra bontva)

1. **Tűzfal** (#1) — a legnagyobb egyszeri nyereség; óvatos allow-lista + enable.
2. **Admin/vault portok LAN-bind** (#2-4) — gyors, magas hozam, reverzibilis (compose port-bind átírás + recreate).
3. **DB/WP latest-pin** (#5, #8) — gyors.
4. **Fontos latest-pin** (#9) — közepes.
5. **Root-migráció + maradék** (P3) — később, ráérősen.

> Minden fix **reverzibilis** (compose-átírás + recreate) és **per-szolgáltatás** tesztelhető. READ-ONLY audit — a végrehajtás külön op-jóváhagyott kártya(ka)t igényel.
