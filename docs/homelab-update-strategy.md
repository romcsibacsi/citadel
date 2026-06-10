# Docker-monitor + profi, config-megőrző frissítési stratégia

> RELAY (netops) — 2026-06-10 · Kanban #31948b0d · **READ-ONLY advisory** (a homelabon semmit nem
> változtattam; ez elemzés + ajánlás, az operátor dönt).

Az operátor 4 kérdésére, közérthetően. A lényeg a **#4** (hogy ne vesszenek el a beállítások frissítéskor).

---

## 1) Saját, CITADEL-be integrált Docker-monitor — megéri?

**Megvalósítható?** Igen. A CITADEL dashboard a hoston fut, eléri a Dockert, és már van token-védett
API-ja. Egy „Docker státusz" panel (futó/leállt konténerek, health, CPU/RAM, restart-policy, melyik
stack) technikailag belefér — ez **FORGE-feladat** lenne.

**Mennyi meló?**
- *Alap, élő státusz-tábla* (a `docker ps`/`stats`/`inspect` kiolvasása + egy panel): nagyjából **1–2 nap** FORGE-munka.
- *History-grafikon + riasztás* (CPU/RAM idősor, „leesett egy konténer" push): **több nap**, és gyakorlatilag azt
  építenénk újra, amit a Beszel **ingyen, kész** ad.

**Kész eszközhöz képest mit adna?** Egyetlen felület (minden a CITADEL-en belül), teljes kontroll a
megjelenésen. **Cserébe** karbantartási teher nálunk, és a history/riasztás munkás.

**Ajánlás:** ne építsünk saját history-monitort — arra a Beszel jobb ár/érték. Saját panel CSAK akkor
éri meg, ha tényleg EGY felületre akarod az egészet a CITADEL-ben; akkor is **minimállal** kezdj (csak
státusz-tábla), és a history/riasztást hagyd a Beszelre. Vagyis: **kész eszköz a metrikára, saját panel
legfeljebb kényelmi „összesítő"** később.

## 2) Miért Beszel + Uptime Kuma (a Dashy mellett)?

A kettő **más kérdésre** válaszol, ezért egészíti ki egymást:

- **Beszel** = „**egészséges-e és mennyit eszik?**" Könnyű élő szerver- és konténer-**metrika** (CPU, RAM,
  hálózat, lemez) **history-grafikonnal** és riasztással. Ezt látod EGY pillantásra — pont amit a Dashy nem tud.
- **Uptime Kuma** = „**fent van-e, elérhető-e?**" Elérhetőség-monitor (HTTP/TCP/ping): ha egy szolgáltatás
  leesik, **azonnal szól** (és nálad már megvan az **ntfy** → telefonra push). 
- **Dashy** marad, ami: **launcher** (linkgyűjtemény), nem státusz.

Röviden: Beszel = belső egészség/erőforrás, Uptime Kuma = kívülről elérhetőség + riasztás, Dashy = gyorslinkek.

## 3) A Portainer (már fut, :9000) is jó erre?

A Portainer **teljes Docker-management**: konténer/stack/volume/hálózat kezelés, log, webkonzol. Erre kiváló
és **érdemes megtartani** — a ritka „kézzel belenyúlok" műveletekhez. **DE** „egy pillantásra státusz +
history" célra **nehézkesebb**: admin-súlyú felület, nincs szép erőforrás-idősor, és a teljes Docker-socketet
(≈ root-jogkör) használja, ezért nem azt akarod egész nap nyitva tartani „műszerfalnak".

**Ajánlás:** Portainer **marad** managementnek; a napi „műszerfal" szerepet a Beszel + Uptime Kuma viszi.
A három nem versenyez — más-más munka.

---

## 4) PROFI, CONFIG-MEGŐRZŐ FRISSÍTÉSI STRATÉGIA (a fő kérés)

**Az aggály:** „nehéz volt összehozni, hogy a *arr-ek + qBittorrent együttműködjenek; ne vesszenek el a
beállítások frissítéskor."

### Először a jó hír — a setupod READ-ONLY elemzése
Megnéztem, hogyan állnak most a konténerek. A **beállításaid biztonságban vannak**, és itt van, miért:

| App | Config helye | Image-tag |
|---|---|---|
| prowlarr | **bind:** `/home/uplinkfather/docker/prowlarr/config` → /config | `:latest` |
| qbittorrent | **bind:** `/home/uplinkfather/docker/qbittorrent/config` → /config | `:latest` |
| radarr | **bind:** `/home/uplinkfather/docker/radarr/config` → /config | `:latest` |
| sonarr | **bind:** `/home/uplinkfather/docker/sonarr/config` → /config | `:latest` |
| overseerr | **bind:** `/home/uplinkfather/docker/overseerr/config` → /config | `:latest` |

- **Minden app `/config`-ja a HOST lemezén van** (bind-mount), NEM a konténer-image-ben. Itt lakik minden
  beállítás: az indexerek, a letöltő-kliens kapcsolat, az API-kulcsok, a teljes adatbázis.
- **Közös letöltőmappa:** qbittorrent, radarr, sonarr mind ugyanazt látja: `/mnt/raid/Media/Downloads`.
  Így adja át qBittorrent a kész letöltést a radarr/sonarr-nak (→ `/movies`, `/tv`).
- **Hogyan beszélnek egymással:** külön compose-hálókon vannak, tehát **host-IP:porton** kapcsolódnak
  (pl. Prowlarr → radarr:7878 / sonarr:8989; radarr/sonarr → qBittorrent:8080 API). **Amíg a portok nem
  változnak, a kapcsolat egy újraindítást/frissítést túlél.**

### Miért NEM vész el a config frissítéskor (a kulcs-elv)
A Docker-frissítés = **az image cseréje, majd a konténer ÚJRALÉTREHOZÁSA**. Az image a „program", a `/config`
a „te adatod". Mivel a `/config` a hoston, **külön él** a konténertől: az image cseréje **hozzá sem ér**. Az új
konténer ugyanazt a `/config`-mappát csatolja vissza → minden beállításod ott van. (Adatot a `down -v` /
volume-törlés vinne el — azt nem csináljuk.)

### A profi munkafolyamat (lépésről lépésre, ezt ajánlom)

**(a) Verzió-PIN a `:latest` helyett — a kiszámíthatóságért.**
A `:latest` azt jelenti, hogy két frissítés bármekkorát ugorhat. Írd a compose-ban a konkrét verziót, pl.:
`linuxserver/radarr:5.14.0` a `:latest` helyett. Így TE döntöd el, mikor és mekkorát lépsz — nincs meglepetés.

**(b) Frissítés ELŐTT mindig config-backup.**
Mivel a config egy host-mappa, a mentés egyszerű — pl. leállítva pillanatkép a `/config`-ról:
```
docker stop radarr
tar czf ~/backups/radarr-config-$(date +%F).tar.gz -C /home/uplinkfather/docker/radarr config
docker start radarr
```
(Vagy a teljes `/home/uplinkfather/docker/*/config` egyben.) Ez a „mentőöv": baj esetén visszacsomagolod.

**(c) EGYENKÉNT, felügyelten frissíts — NE mind egyszerre.**
A *arr-ek lazán összefüggnek; ha egyszerre cserélsz mindent és valami eltörik, nem tudod, melyik volt.
Sorrend-javaslat: előbb a **letöltő-kliens (qBittorrent)**, majd a **Prowlarr**, végül **radarr/sonarr** —
egyesével:
```
cd /home/uplinkfather/docker/radarr
docker compose pull        # új image letöltése
docker compose up -d        # csak ezt a konténert húzza újra, a /config marad
docker compose logs -f       # figyeld, rendesen elindul-e
```

**(d) Teszt UTÁNA — működik-e az összekötés?**
Minden frissített appnál nézd meg a webfelületet, és kifejezetten a **kapcsolatokat**:
- Prowlarr → Settings/Apps: a radarr/sonarr „Test" zöld?
- radarr/sonarr → Settings/Download Clients: a qBittorrent „Test" zöld?
Ha zöld, a Prowlarr↔qBittorrent↔*arr lánc él.

**(e) ROLLBACK, ha valami eltörik.**
Mivel pinned a tag és van backupod, a visszaállás triviális: a compose-ban állítsd vissza az ELŐZŐ verziót,
és `docker compose up -d`. Ha a config gyanús, csomagold vissza a (b) tar-t. Az adat végig megvolt.

**(f) Mi tartsa karban / figyelje a frissítéseket?**
- A **wud** (már fut, notify-only) **szól ntfy-n**, ha új image van — TE döntesz, mikor frissítesz. Ez a helyes
  modell: „értesít, majd kézzel, felügyelten". (A felügyelet nélküli auto-update — a most kivezetett watchtower —
  pont a te aggályod kockázata volt: hajnalban magától cserélt. Jól jártunk vele, hogy kivezettük.)
- Opcionálisan **Dockge** (könnyű compose-UI): a stackjeidet egy felületről, kézi „pull + recreate" gombbal
  frissíthetnéd — átláthatóbb, mint a CLI, és NEM auto. (Telepítés op-döntés; nem most.)

### Mi GARANTÁLJA, hogy a Prowlarr↔qBittorrent összekötés nem törik el?
1. A kapcsolat **adatai** (cím, port, API-kulcs) a `/config`-ban vannak a host-on → a frissítés nem nyúl hozzá.
2. A kapcsolat **útja** host-IP:port → amíg a published portokat (7878/8989/8080/9696) nem írod át, a cím marad.
3. **Egyenkénti** frissítés + utána a **„Test" gombok** → ha valami mégis megakad, azonnal látod, melyik lánc,
   és (e) szerint visszagörgetsz. A három együtt = a beállítások gyakorlatilag nem veszhetnek el.

### Egymondatos összefoglaló az operátornak
A beállításaid a host-lemezen, a konténeren kívül élnek, így a frissítés nem törli őket; pinneld a verziókat,
ments a `/config`-ról frissítés előtt, frissíts egyesével + teszteld a „Test" gombokat, és tartsd meg a wud
értesítőt a felügyelt (nem automatikus) frissítéshez — így a Prowlarr↔qBittorrent↔*arr lánc biztosan megmarad.
