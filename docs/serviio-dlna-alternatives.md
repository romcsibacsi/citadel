# Serviio → maintainelt DLNA-szerver — PROPOSAL (RELAY, 2026-06-11, #0e3344e3)

**Miért:** a Serviio image (`lsiocommunity/serviio`) **archivált, 2019-es build** (a linuxserver-community repo megszűnt) — nincs frissítés, CVE-kockázat. Kell egy karbantartott DLNA/UPnP-szerver, ami a Serviio fő funkcióját (média streamelése DLNA-klienseknek: smart TV, lejátszók) átveszi.

**Adottságok (felmérve):**
- A Serviio a **`/mnt/raid/Media`** könyvtárat szolgálja (config: `/mnt/raid/serviio/config`, transcode: `/mnt/raid/serviio/transcode`).
- Ez **ugyanaz a média-könyvtár**, amit a Plex/radarr/sonarr is használ → **bármely alternatíva újrahasználhatja**, nincs adat-mozgatás.
- A **Plex MÁR FUT host-network módban** → a beépített DLNA-ja működhet **extra konténer nélkül**.
- Követelmény: **LAN-only**, nincs net-kitettség (mint most).

## Opciók

| Opció | Karbantartottság | DLNA/UPnP | Erőforrás | Migrációs költség | Megjegyzés |
|---|---|---|---|---|---|
| **Plex beépített DLNA** (már fut) | aktív (Plex) | van, de **Plex deprecálta** (alapból off, jövőben kivezethetik) | 0 (megvan) | **nulla** (Settings→DLNA bekapcsol) | Gyors teszt; de NEM jövőbiztos a deprecáció miatt |
| **Gerbera** (gerbera/gerbera) | **aktív** (MediaTomb modern utódja, rendszeres release) | **tiszta UPnP/DLNA**, kiváló kliens-láthatóság | **nagyon kicsi** (headless, ideális NAS-ra) | alacsony (1 kis konténer, /mnt/raid/Media bind, LAN host-net) | Nyers fájlokat streamel; a „dedikált DLNA-szerver" szerepre a legjobb |
| **Universal Media Server** (universalmediaserver/ums) | **aktív** (rendszeres release) | DLNA/UPnP **+ on-the-fly transcoding** | közepes (Java, mint a Serviio) | közepes (új konténer + config) | **A Serviióhoz legközelebbi parity** (Java + transcode) — ha a Serviio transcode-ja kellett inkompatibilis formátumokhoz |
| Jellyfin (jellyfin/jellyfin) | nagyon aktív | van DLNA, de teljes media-szerver | nagyobb (cache/thumbnail) | magas (teljes szerver-setup) | Overkill DLNA-ra, mikor Plex már viszi a „media-szerver" szerepet; csak ha Plexet is le akarnád cserélni |

## AJÁNLÁS

1. **Gyors próba ELŐBB (0 költség): Plex beépített DLNA.** A Plex már fut host-network módban; a Settings → DLNA bekapcsolásával kiderül, hogy az op DLNA-kliensei (TV-k/lejátszók) elégednek-e vele. Ha igen → **nem kell külön szerver**, a Serviio simán kivezethető. ⚠️ De: a Plex a DLNA-t **deprecálta** (alapból kikapcsolt, jövőben megszűnhet) → nem jövőbiztos önmagában.

2. **Tartós ajánlás: Gerbera.** Ha kell dedikált, jövőbiztos DLNA-szerver: a Gerbera aktívan karbantartott, pici, tiszta UPnP/DLNA, kiváló kliens-kompatibilitás, újrahasználja a `/mnt/raid/Media`-t, LAN-only (host-network). Ez a **legjobb 1:1 Serviio-csere** a Java-súly nélkül. Alacsony migrációs költség.

3. **Ha a Serviio transcode-ja kellett** (inkompatibilis formátumok on-the-fly átkódolása): **Universal Media Server** (Java, mint a Serviio, de karbantartott) a legközelebbi funkció-parity.

**Döntési segéd:** *„Csak streameljen a TV-nek?"* → próbáld a Plex DLNA-t, tartósra Gerbera. *„Kellett a Serviio transcode-ja?"* → UMS. *„Plexet is le akarom váltani?"* → Jellyfin (de az külön, nagyobb projekt).

> READ-ONLY proposal — semmit nem állítottam le/migráltam. Az op dönt, utána külön kártya a migrációra (akkor: új konténer host-net + `/mnt/raid/Media` bind, LAN-only, verify a TV-n, majd a Serviio kivezetése).

**Források:** [Gerbera vs Jellyfin (XDA)](https://www.xda-developers.com/tried-gerbera-instead-of-jellyfin-how-went/) · [UPnP AV media servers (Wikipedia)](https://en.wikipedia.org/wiki/Comparison_of_UPnP_AV_media_servers) · [Best DLNA servers for Linux (It's FOSS)](https://itsfoss.gitlab.io/post/9-best-free-upnp-and-dlna-servers-for-linux-in-2024/)
