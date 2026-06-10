# CITADEL iOS app — terv (plan)

> Cél: az operátor a telefonjáról elérje és kezelje a CITADEL dashboardot (NEXUS-chat, ágensek,
> kanban, studio, értesítések). Ez a dokumentum a megalapozott terv; a megvalósítás külön lépés.
> Forrás: a teljes API-felület (175 végpont) feltérképezése + 4 független architektúra/biztonsági elemzés.

## TL;DR — ajánlott útvonal

**NE épüljön teljes natív app.** A dashboard **már most regisztrált PWA** (manifest + service worker +
Apple meta tagek + token-bootstrap), tehát a mobil-UI ~95%-ban kész. A három független architektúra-elemzés
egybehangzóan ezt adta:

| Opció | Munka | Mit ad |
|---|---|---|
| **0. HTTPS + PWA (add-to-homescreen)** | ~órák | Home-screen ikon, teljes képernyő, offline shell, ntfy push — **majdnem 0 új kód** |
| **1. Vékony WKWebView shell** | ~1 nap | + Keychain token-tárolás + **Face ID zár** + natív push-deeplink |
| **2. Hibrid / szelektív natív** | ~3-5 hét | Pár képernyő natív (overview, NEXUS-chat); a többi webview marad |
| **3. Teljes natív parity** | hetek | 175 végpont UI-jának újraírása — **kerülendő** egy egyfelhasználós eszköznél |

**Javaslat: Fázis 0 + Fázis 1.** Egy fél-egy nap alatt valódi "app a telefonon" érzet, hardver-háttér
token-zárral, a meglévő SPA újraírása nélkül. A natív képernyők (Fázis 2) csak akkor, ha napi használat
ezt indokolja.

## A legfontosabb döntés — connectivity (ez gátol minden mást)

A dashboard jelenleg **HTTP, `0.0.0.0:3420`, csak LAN**. iOS-en a tiszta HTTP-t az App Transport Security
(ATS) blokkolja, és a PWA service worker is csak HTTPS (secure context) alatt regisztrál. A token pedig
**root-ekvivalens**: egyetlen Bearer string nyit minden `/api/*` végpontot (folyamat-indítás
`POST /api/background-tasks`, billentyű-injektálás `POST /api/agents/:name/keys`, titok-olvasás
`/api/vault/:id`). Ezért a connectivity-döntést a "**ezt a tokent ne tedd ki a publikus internetre**" elv uralja.

| Opció | Mi ez | ATS | Biztonsági ítélet |
|---|---|---|---|
| **A. ATS-kivétel a LAN IP-re** | `Info.plist` NSExceptionDomains a 192.168.1.105-re | OK | Token **titkosítatlanul** a LAN-on; DHCP-re törékeny. Csak ideiglenes, LAN-only build. |
| **B. NPM subdomain + HTTPS** | a futó nginx-proxy-manager TLS-t terminál, proxy → 127.0.0.1:3420 | tiszta (Let's Encrypt) | Titkosít, **de** a dashboard innentől internetről elérhető, és az egyetlen védő egy statikus token. **Csak NPM Access List / mTLS mögött** elfogadható. |
| **C. Tailscale (WireGuard mesh)** ✅ | iOS belép a tailnetbe; `https://citadel.<tailnet>.ts.net` MagicDNS-cert | tiszta, **plist-kivétel nélkül** | **Legjobb.** A token sosem hagyja el a titkosított alagutat; a listener privát marad; a tailnet-eszközazonosság valódi 2. faktor; LAN-on és mobilneten egyformán működik. |
| D. Marad LAN-only | semmi | blokkolt | natív apphoz non-starter |

**Ajánlás: C — Tailscale.** Indok: a token root-ekvivalens és a szerver folyamatot indít / ágenst vezérel,
így a publikus kitettség költsége katasztrofális, az előnyt (LAN-on kívüli elérés) viszont a WireGuard-mesh
ugyanúgy megadja. A Tailscale egyszerre hozza mindhármat: ATS-tiszta HTTPS, nulla publikus felület, és
eszköz-identitás mint 2. faktor.

Konkrétan (Fázis 0):
- `tailscale` telepítése a hostra (jelenleg **NINCS** telepítve). Sudo-mentes/standalone megoldható.
- `WEB_HOST` állítása `127.0.0.1`-re (vagy a `tailscale0` interfészre); a mostani `0.0.0.0` bind megszüntetése.
- `tailscale serve https / http://127.0.0.1:3420` → HTTPS a MagicDNS néven.
- `.env`: `DASHBOARD_PUBLIC_URL=https://citadel.<tailnet>.ts.net`, hogy a CORS `allowedOrigins`
  (`src/web.ts:66-71`) elfogadja az originből jövő állapotváltó POST-okat (különben 403, `src/web.ts:92`).

> **ASSUMPTION:** az operátornak van/lehet Tailscale-fiókja és telepíthető a kliens az iPhone-ra.
> Ha ez kizárt, a tartalék: **B + NPM Access List**, soha nem B önmagában a tokennel mint egyetlen kapu.

## Architektúra — fázisok

### Fázis 0 — HTTPS + PWA (órák)
A meglévő PWA (`web/manifest.json` `display:standalone`, `web/sw.js` — az `/api/*` szándékosan
**network-only**, `sw.js:71`, `web/app.js:16-58` token-bootstrap) HTTPS alatt azonnal telepíthető a
kezdőképernyőre. Apró polish (opcionális): `manifest.shortcuts` (long-press → Kanban/NEXUS-chat),
180×180 `apple-touch-icon`. Push: a **hivatalos ntfy iOS app** feliratkozik a meglévő `NTFY_TOPIC`-ra —
szerveroldali munka **nulla**, mert az ntfy már bekötve (`src/ntfy.ts`, `src/notify.ts`).

### Fázis 1 — vékony WKWebView shell (~1 nap, Mac + Xcode + Apple Developer fiók kell)
Egy ~200 soros SwiftUI app, ami a HTTPS-origint tölti `WKWebView`-ben, és pontosan azt a 3 dolgot adja,
amit a PWA iOS-en nem tud:
1. **Keychain token-injektálás.** A Bearer a iOS Keychainben (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
   + `SecAccessControl .biometryCurrentSet`); betöltéskor `WKUserScript` `.atDocumentStart` beírja:
   `localStorage.setItem('nexus-dashboard-token', '<token>')` — a meglévő `app.js` bootstrap **web-oldali
   változtatás nélkül** felveszi. Megszűnik a törékeny `?token=` URL-átadás.
2. **Face ID zár app-indításkor.** `LAContext.evaluatePolicy(...)` a webview megjelenítése előtt,
   passcode-fallbackkel. Ez a fő nyereség: valódi zár egy homelab-vezérlőfelületen.
3. **Push az ntfy újrahasznosításával.** Elsőre a ntfy iOS app (3a, lásd lent); a notifikáció `Click`
   URL-je mély-linkel a megfelelő képernyőre.

Shell-extrák majdnem ingyen: `limitsNavigationsToAppBoundDomains` (a shell a CITADEL-subdomainre zárva),
pull-to-refresh, `WKScriptMessageHandler` bridge későbbi natív megosztáshoz.

### Fázis 2 — szelektív natív (opcionális, ~3-5 hét, csak ha indokolt)
Natívra csak az éri meg, ami telefonon valóban jobb: **NEXUS-chat** (compose, haptika), **overview-glance**
(WidgetKit/Live Activity), és az **élő ágens-pane** (SSE). Minden config-felület (vault, connectors,
schedules, kanban-admin, MCP) marad webview. A seam (natív vs web) és a deep-link router a nehéz rész.

## Auth és biztonság

- **A token root-ekvivalens, egyetlen statikus Bearer**, nincs scope/expiry/revoke (`src/web/dashboard-auth.ts`,
  konstans-idejű `timingSafeEqual`). Tárolás iOS Keychainben, Face ID mögött; sosem `UserDefaults`-ban, sosem URL-ben.
- **Token bejuttatása:** QR-pairing — a desktop dashboard mutassa a `/?token=...` bootstrap URL-t
  (a Tailscale HTTPS-hosttal) QR-ként, az app VisionKit-tel beolvassa. Tartalék: paste. A token a
  TLS/WireGuard csatornán `Authorization: Bearer`-ként megy; a `?token=` query CSAK a két fejléc-mentes
  GET-re kell (SSE pane stream, `/api/files/raw`).
- **Rotáció:** `store/.dashboard-token` törlése + restart → új token → újra-pairing QR-rel. Online
  revoke/rotate végpont **nincs** (UNKNOWN/future). Az app `401`-re ürítse a Keychaint és essen vissza pairingre.
- **Future hardening (szerver, kis additív munka):** **per-eszköz token** — `POST /api/devices` másodlagos
  Bearert mint, kis táblába; `DELETE /api/devices/:id` revoke; `checkBearerToken` fogadja a master mellett.
  Ezzel egy elveszett telefon nem a teljes homelabot viszi, és a rotáció nem logol ki mindent.

## Real-time és push

- **SSE pane stream** (`GET /api/agents/:name/pane/stream`, ~700ms, **teljes ANSI-snapshot** frame-enként,
  `?token=`): iOS-en nincs natív `EventSource` → vagy webview-ben fut, vagy `URLSession.bytes(for:)` natív
  parse. **Háttérben nem él túl** (iOS felfüggeszti) → tear-down `background`-ban, re-open `foreground`-ban,
  exponenciális backoff+jitter. Olcsó állapothoz inkább a `GET /api/agents/activity` (~3s) polling.
- **Push = ntfy (már bekötve).** Két út:
  - **(a) ntfy iOS app** — nulla szerveroldali munka, azonnal működik; a `Click` URL mély-linkel. **Ezt elsőre.**
    Self-hosted ntfy-nál az iOS-app upstream/poll-bridge konfig kell az APNs-kézbesítéshez; a topic legyen
    kitalálhatatlan + `NTFY_TOKEN`.
  - **(b) natív APNs** — legjobb UX (badge, action gombok, locked-screen deep-link), de Apple push-kulcs +
    `POST /api/devices` (nincs ma) + ntfy→APNs bridge kell. Csak v2, ha tényleg kell.
- **Esemény → push térkép:** heartbeat-eszkaláció `urgent`; ágens-beragadás / reauth `high`; spawn-kérés
  jóváhagyásra `high`; task kész/hibás `default`/`high`; idea felszínre csak autonómia ≥2-nél `low`;
  rutin-aktivitás **soha** (pull-only). Az eszkalációkat tartsd `high`/`urgent`-en, hogy átüssenek a Focus-on.

## Feature-felület (mit tud az app megjeleníteni)

A 175 végpontból **22 "core"** mobilra, 21 real-time. A magprojekt-felület:

- **Chat / NEXUS:** `GET /api/nexus`, `GET /api/messages/threads`, `GET /api/messages?agent=`,
  `POST /api/operator/message` (a szerver `from=operator`-t bélyegez).
- **Ágensek:** `GET /api/agents`, `GET /api/agents/activity`, `POST /api/agents/:name/{start,stop,restart}`,
  élő pane SSE, `POST /api/agents/:name/keys`.
- **Overview:** `GET /api/overview`, `GET /api/status`.
- **Kanban:** `GET/POST /api/kanban`, `PUT /api/kanban/:id`, `POST /api/kanban/:id/move` (in_progress →
  egyszeri ágens-dispatch).
- **Ötletláda:** `GET/POST /api/ideas`.
- **Studio (média-gen):** `POST /api/studio/run` (async jobId), `GET /api/studio/job?id=`,
  `GET /api/files/raw` (kép-előnézet, `?token=`).
- **Háttér-taszkok:** `POST/GET /api/background-tasks`, `GET /api/background-tasks/:id` (élő tmux-tail).

A "low/skip" besorolású ~100 végpont (connectors, profiles, migrate, MCP-katalógus stb.) desktop-admin —
webview-ben marad, natívra nem éri meg.

## Szerveroldali változások (mind kicsi, additív)

1. **Fázis 0 előfeltétel:** `DASHBOARD_PUBLIC_URL` a HTTPS-originre, `WEB_HOST=127.0.0.1`/`tailscale0`
   (a `0.0.0.0` bind megszüntetése). Csak env + bind, nincs kódváltás.
2. **Push deep-link (opcionális, Fázis 1):** az ntfy hívásokban a `click` mező kitöltése `citadel://...`
   vagy universal-link URL-lel (`src/notify.ts`, `src/heartbeat-triage.ts` — a `NtfyOptions.click` már
   létezik `src/ntfy.ts`-ben, csak nincs caller, aki beállítja).
3. **Per-eszköz token (opcionális, hardening):** `POST /api/devices` + `DELETE /api/devices/:id` +
   `checkBearerToken` kiterjesztés.
4. **Natív APNs (opcionális, v2):** device-token endpoint + APNs sender a `notifyAlert` mellé.

## Kockázatok / UNKNOWN / ASSUMPTION

- **ASSUMPTION:** van Mac + Xcode + Apple Developer fiók a shell/natív buildhez (a Fázis 0 PWA ezek nélkül is megy).
- **ASSUMPTION:** Tailscale használható; különben NPM+Access List a tartalék.
- **UNKNOWN:** nincs online token-rotáció/revoke és nincs one-time-pairing/APNs device endpoint — mind új szerver-munka.
- **KOCKÁZAT:** a statikus master token egy telefonon = teljes homelab blast-radius elvesztett eszköznél.
  Mérséklés: Tailscale + Keychain `.biometryCurrentSet` + per-eszköz token (jövő).
- **Regresszió:** Fázis 0-ban a `WEB_HOST` váltás (0.0.0.0 → localhost) megszünteti a jelenlegi közvetlen
  LAN-elérést — ez szándékos, de a desktop-böngésző hozzáférést a Tailscale/NPM originre kell átállítani.

## Következő lépés

Ha az útvonal rendben: **Fázis 0** (Tailscale + HTTPS + `DASHBOARD_PUBLIC_URL`/`WEB_HOST` + add-to-homescreen
+ ntfy app) — ez órák alatt valódi telefonos elérést ad. Utána **Fázis 1** (WKWebView shell) a Face ID zárhoz.
