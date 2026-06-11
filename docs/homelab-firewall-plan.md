# Host-tűzfal — Docker+ufw ütközés: diagnózis + Docker-tudatos terv

> RELAY (netops) — 2026-06-11 · Kanban #fb1e71a1 · **READ-ONLY diagnózis + terv.**
> Az éles bekapcsolás külön op-GO + felügyelt teszt-ablak. A homelab szent.

## 1. DIAGNÓZIS — miért tört el a tűzfal

**A Docker megkerüli az ufw INPUT-ját.** Igazolva ezen a hoston:
- A `nat/DOCKER` lánc DNAT-olja a published portokat a konténer-IP-kre; a `filter/DOCKER` lánc (**40 referencia**) ACCEPT-eli őket a **FORWARD** úton — tehát a bridge-konténer-portok **NEM** az INPUT-on mennek át.
- A `DOCKER-USER` lánc létezik; az `/etc/ufw/after.rules` **MÁR tartalmaz egy korrekt ufw-docker blokkot**: LAN-source (10/8, 172.16/12, 192.168/16) → RETURN (allow); internet-source NEW → DROP. (Vagyis aktív ufw mellett: a bridge-konténerekhez a LAN hozzáfér, az internet nem.)
- `ufw-docker` helper telepítve (`/usr/local/bin/ufw-docker`).
- ufw **konfigurálva de INAKTÍV**: `DEFAULT_INPUT_POLICY="DROP"`, 41 allow-szabály (köztük SSH 22 + 33333, NPM 80, dashy 4000...).

**A gyökérok (miért „tört el minden", amikor bekapcsolták):**
A `DEFAULT_INPUT_POLICY=DROP` a **HOST-NETWORK konténerek** és a host saját szolgáltatásainak portjait blokkolja, mert ezek **közvetlenül a hoston** figyelnek → az **INPUT** láncon mennek (nem a DOCKER láncon), és a 41-es allow-lista **hiányos** volt rájuk.
Host-network konténerek (INPUT-függők): **homeassistant (8123), plex (32400 + 32469/1900/32410-14), serviio (23423, 8895, 1900/udp), go2rtc (1984 + RTSP/webrtc), cloudflared (csak kimenő → nem kell inbound), beszel-agent (unix socket → nem kell port).**
A bridge-published portok (radarr, NPM, mailcow, nextcloud, ...) viszont a DOCKER-USER blokk miatt LAN-ról elérhetők maradnak — azok NEM tördek volna el.

## 2. A BEVÁLT (Docker-tudatos) MEGOLDÁS

Két, egymást kiegészítő réteg — ez NEM a naiv „ufw enable":
- **Bridge-konténer-portok:** a meglévő `after.rules` DOCKER-USER blokk kezeli (LAN-allow, internet-deny). Marad. (Ha egy bridge-szolgáltatást az internetnek IS ki kell tenni — pl. NPM 80/443 direkt router-forwarddal — arra explicit `ufw-docker allow <konténer> <port>` kell; ha cloudflared-tunnelen át megy, nem kell inbound szabály.)
- **Host-szint + host-network konténerek:** sima `ufw allow` az INPUT-on — **a hiányos allow-lista KIEGÉSZÍTÉSE** a host-network portokkal.

## 3. KONKRÉT TERV (tesztelhető, lockout-biztos)

### 3.1 Az INPUT allow-lista kiegészítése (a futó hiányosság)
A LAN-subnetről (`192.168.1.0/24`, ill. ahonnan elérni kell) engedélyezni:
- **SSH (LOCKOUT-BIZTOSÍTÉK):** 33333 (aktív) **és** 22 — már bent vannak, ellenőrizni.
- **Host-network konténerek:** `8123` (HA), `32400` + `32469/tcp` + `1900/udp` + `32410:32414/udp` (Plex GDM/DLNA), `23423,8895` + `1900/udp` (Serviio DLNA), `1984` (+ go2rtc RTSP/webrtc, ha használt).
- **Host saját szolgáltatásai:** `ss -lntp`-ből a NEM docker-proxy listenerek (a teszt-ablakban véglegesíteni).
- Internet-felé szándékosan kitett (ha direkt-forward, nem cloudflared): NPM 80/443, mailcow 25/465/587/993/995/143/110, wireguard 51821/udp → ezek vagy a DOCKER-USER `ufw-docker allow`-on, vagy host-network esetén INPUT-allow.

### 3.2 Lockout-biztosíték (KÖTELEZŐ)
1. SSH-allow (33333+22) MEGVAN — ellenőrizni `ufw enable` ELŐTT.
2. **Auto-disable háló:** `echo 'ufw --force disable' | at now + 10 minutes` — ha kizárnánk magunkat, 10 perc múlva magától kikapcsol. Sikeres verify után az `at`-job törölve (`atrm`).
3. Konzol/fizikai hozzáférés mint végső fallback.

### 3.3 Lépésenkénti teszt (felügyelt ablak, op jelen)
1. Allow-szabályok beállítása (ufw MÉG inaktív — csak konfig).
2. `at`-auto-disable beállítása.
3. `ufw --force enable`.
4. **AZONNAL:** új SSH-session a 33333-on (megy-e?).
5. Mintavétel MINDEN kategóriából: bridge-LAN (radarr 7878 / dashboard 3420), host-network (HA 8123, Plex 32400, Serviio 23423), mailcow web (8443), NPM (80/443), adguard DNS (53).
6. Minden zöld → `atrm` (auto-disable törlése). Bármi kiesik → `ufw disable` (vagy hagyni az `at`-ot lefutni) + a hiányzó allow pótlása, újra.

## 4. KOCKÁZAT / ALTERNATÍVA
- **Ráfordítás:** közepes; a fő kockázat a hiányos allow-lista (lásd a host-network portokat). A lockout-háló kezeli.
- **Ha túl kockázatosnak ítéli az op:** a tűzfal helyett/előtt a **kitett admin/vault-portok LAN-bindje** (másik P1-kártya: code-server/portainer/mcp-* → `192.168.1.105`). Ez gyorsabb és kisebb kockázat, bár gyengébb (nem véd kompromittált LAN-eszköz ellen, és nem ad internet-deny réteget — azt a DOCKER-USER blokk + ufw adná).
- **Ajánlás:** mivel a Docker-tudatos infrastruktúra (after.rules DOCKER-USER + ufw-docker) MÁR készen áll, a tűzfal bekapcsolása a kiegészített allow-listával + a lockout-hálóval **reális és nagy hozamú** — egy felügyelt ablakban. Ez a javasolt út.

---

## 5. VÉGREHAJTVA — 2026-06-12 (felügyelt ablak, op-GO) ✅

A tűzfal **BEKAPCSOLVA és verifikálva**. A tervhez képest egy MÁSODIK gyökérokot is felfedtem a felügyelt ablakban:

**2. gyökérok (a terv kihagyta):** a *arr-lánc (prowlarr→radarr/sonarr, *arr→qbittorrent) a **host-IP:porton** (192.168.1.105:7878/8989/8080) kommunikál (külön compose-hálók). Ez a forgalom a docker-proxyn át a host **INPUT**-láncára kerül, **docker-subnet forrással (172.x/10.x)** — amire nem volt INPUT-allow → DROP. Az első enable emiatt törte a *arr-kommot (és a NPM 443 hairpin-tesztet).

**A fix (ami zöldre hozta):** a host-network portok engedélyezése MELLETT az **összes belső/RFC1918 forrás engedélyezése az INPUT-on**: `ufw allow from 10.0.0.0/8`, `from 172.16.0.0/12`, `from 192.168.0.0/16`. Ezzel: belső (LAN + docker + VPN) → mindent elér; internet (publikus IP) → default DROP, kivéve a szándékosan publikus szolgáltatásokat (mailcow 25/465/587/993, NPM 80/443, wireguard — saját 0.0.0.0/0 allow).

**Verify (mind ZÖLD, ufw active):** *arr-komm (container→host-IP) 200, NPM 443 302, HA/Plex/Serviio/go2rtc 200, mailcow UI+SMTP, bridge *arr + dashboard 200, AdGuard DNS feloldás, SSH 33333. **Internet-blokk élőben igazolva** (UFW BLOCK log: internet-IP-k droppolva a 6881-en). ufw startup-enabled (reboot-álló).

**Rollback:** `sudo ufw disable` (azonnal vissza). Lockout-háló (systemd-run auto-disable) használva a teszt alatt, sikeres verify után törölve.
