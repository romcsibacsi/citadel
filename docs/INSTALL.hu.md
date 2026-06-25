# Telepítési útmutató

> English version: [INSTALL.en.md](INSTALL.en.md)

Ez a teljes telepítési útmutató: tiszta géptől a futó flottáig, megnyitott
dashboarddal és — ha kéred — bekötött Telegram-csatornával.

Mielőtt bárminek nekiállnál, menj végig az
**[előfeltételeken](PREREQUISITES.hu.md)**: Linux x64 (tesztelve Ubuntu
24.04-en), Node.js >= 22.5 a `node:sqlite` modullal, npm, tmux >= 3.x, és a
Claude Code CLI (`claude`) **előfizetéses OAuth** bejelentkezéssel — továbbá
győződj meg róla, hogy a számlázást átkapcsoló változók (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`)
egyike **sehol nincs** beállítva
(az `env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE'` semmit nem írhat ki).

## 1. A repó klónozása

```bash
git clone <your-repo-url> fable5-build
cd fable5-build
```

## 2. A telepítő futtatása

Egyetlen parancs:

```bash
./scripts/install.sh
```

Kapcsolók:

- `--locale hu|en` — a telepítéskori alapértelmezett nyelv beállítása kérdezés
  nélkül.
- `--yes` — teljesen interakciómentes futás; ha nincs `--locale`, a magyar
  (`hu`) lesz az alapértelmezés.

```bash
./scripts/install.sh --locale en --yes    # interakciómentes angol telepítés
```

### Mit csinál a telepítő, lépésről lépésre

1. **Előfeltétel-ellenőrzés** — hiány esetén azonnal, érthető hibaüzenettel
   áll le: Node >= 22.5, olyan Node build, amelyben tényleg van `node:sqlite`,
   npm, tmux, és a `claude` bináris a `PATH`-on.
2. **Számlázásvédelmi elutasítás** — ha a számlázási tiltólista bármely
   változója (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
   `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) be van állítva a
   környezetben, a telepítés **megszakad**. A rendszer kizárólag előfizetéses
   számlázású; egy ottfelejtett hitelesítő adat minden ágens-sessiont csendben
   fogyasztásalapú vagy külső számlázásra kapcsolna át. (Ugyanezt a
   tiltólistát a supervisor indulása és minden ágens-indítás is kikényszeríti.)
3. **Nyelvválasztás** — rákérdez az alapértelmezett nyelvre (`hu`/`en`,
   alapértelmezés: `hu`), hacsak nem adtál meg `--locale`-t vagy `--yes`-t.
4. **`npm ci`** — a (csak fejlesztői) függőségek telepítése a lockfile-ból.
5. **`npm run typecheck` és `npm run build`** — szigorú TypeScript-ellenőrzés,
   majd a backend build (`tsc`) és a dashboard bundle (esbuild).
6. **Első futás inicializálása** — lefuttatja a `node dist/app/main.js
   --init-only --locale <hu|en>` parancsot, amely:
   - létrehozza az **állapotkönyvtárat** (`0700` móddal),
   - telepíti a seed konfigurációt `config.json`-ként (`0600`) — de csak ha
     még nem létezik,
   - megnyitja az SQLite adatbázist (`orchestrator.db`, WAL mód, `0600`-zal
     létrehozva) és lefuttatja az összes sémamigrációt,
   - legenerálja a **dashboard bearer tokent** (`dashboard-token`, `0600`) és
     a **vault mesterkulcsot** (`master.key`, `0600`),
   - kiépíti a roster minden ágensének vázát az `agents/<id>/` alatt
     (munkakönyvtár, config root, skills könyvtár, saját hatókörű
     `agent-token`, `persona.md`, `operating.md`, `CLAUDE.md`),
   - és **stderr-re** kiírja a dashboard **bootstrap URL-jét** (a `?token=`
     paraméterrel).

### Idempotencia — az újrafuttatás biztonságos

A `./scripts/install.sh` bármikor újrafuttatható (pl. `git pull` után).
Garantáltan:

- **soha nem írja felül az operátor által szerkesztett fájlokat** — a
  `config.json`, a personák, az operating contractok és a `CLAUDE.md` fájlok
  csak akkor jönnek létre, ha hiányoznak;
- **soha nem rotálja a meglévő titkokat** — a dashboard token, a vault
  mesterkulcs és az ágensenkénti tokenek egyszer generálódnak, utána
  változatlanok maradnak;
- csak újratelepíti a függőségeket, újrabuildel, és pótolja, ami hiányzik.

### Az állapotkönyvtár

Minden változó állapot a repón kívül él: az `$ORCHESTRATOR_STATE_DIR`-ben, ha
be van állítva, egyébként a `~/.orchestrator` alatt:

```
~/.orchestrator/
├── config.json          # az élő konfiguráció (a seed/seed.config.json-ból)
├── orchestrator.db      # SQLite (WAL): üzenetek, memória, kanban, ütemezések, vault, ...
├── dashboard-token      # root-jogú dashboard bearer (0600)
├── master.key           # vault mesterkulcs (0600)
├── supervisor.lock      # egy-supervisor pidfile (csak futás közben létezik)
├── agents/<id>/         # ágensenként: workdir/, config-root/, skills/, agent-token,
│                        #              persona.md, operating.md
├── skills/              # globális (flottaszintű) skillek
└── logs/                # ágensenkénti session-logok
```

(A hub ágens kicsit más: az ő skill-gyökere *maga* a globális `skills/`
könyvtár, ezért nincs saját `skills/`-e, és hubként `operating.md` contractot
sem kap.)

Ha máshova szeretnéd az állapotot, az `ORCHESTRATOR_STATE_DIR`-t még a
telepítés *előtt* állítsd be, és minden későbbi indításnál is legyen beállítva.

## 3. Első indítás és a bootstrap URL

```bash
npm start        # a node dist/app/main.js parancsot futtatja
```

(Fejlesztéshez ott az `npm run dev`, amely tsx-szel közvetlenül a
TypeScript-forrásokat futtatja.)

Az **első** induláskor (amíg a dashboard token frissen jön létre) a supervisor
a dashboard **bootstrap URL-jét** **stderr-re** írja:

```
CITADEL dashboard: http://127.0.0.1:7080/?token=<hosszú-token>
```

Nyisd meg **eszközönként egyszer**. A SPA a tokent `localStorage`-ba menti és
azonnal eltünteti az URL-ből; utána azon az eszközön a sima
`http://127.0.0.1:7080/` is működik. Minden **későbbi** indulás már csak a
dashboard URL-t írja ki, mellette a tokenfájlra mutató utalással — maga a
token többé nem kerül logba. Ugyanez a bootstrap URL a telepítés végén
(`--init-only` futás) is megjelent, a token pedig bármikor kiolvasható a
0600-as `~/.orchestrator/dashboard-token` fájlból, ha később új eszközt kötnél
be.

A dashboard első betöltésekor egy **vezetett onboarding-varázsló** jelenik meg:
az 1. lépés a Claude bejelentkezés (előfizetés vagy explicit, vaultban tárolt
API-kulcs — az API-módú operátor sincs kizárva), az opcionális lépések pedig a
csatornákat, a lokális Ollamát és a lokális ComfyUI-t fedik, mindegyik élő
✓/○/! státusszal a `/api/onboarding/status`-ból. A befejezés/elvetés
megjegyződik (`onboarding:completed` / `onboarding:dismissed`), így csak egyszer
nyílik meg automatikusan; a dashboardról bármikor újranyitható.

A supervisor ezután elindítja a roster ágenseit interaktív Claude Code
sessionökként a flotta **dedikált tmux szerverén** (`tmux -L citadel-mux`, a
`runtime.claude.socket` állítja; lépcsőzetesen, alapértelmezés szerint 15
másodperces eltolással). A dashboard ágensnézetéből bármelyiket figyelheted és
gépelhetsz is bele — vagy csatlakozhatsz a
`tmux -L citadel-mux attach -t citadel-<agent-id>` paranccsal (a socket a
`runtime.claude.socket`-ból, az előtag a `runtime.claude.sessionPrefix`
beállításból jön). Mivel ez egy dedikált szerver, az ügynökök el vannak
szigetelve a saját tmux-sessionjeidtől, és **túlélik a supervisor újraindítását**
(lásd a systemd-megjegyzést a 4. fejezetben).

## 4. Futtatás szolgáltatásként (systemd)

A `scripts/install.sh` GENERÁL egy kész unitot a **`deploy/orchestrator.service`**
útvonalon a `deploy/orchestrator.service.template`-ből (kitöltve a felhasználódat +
a telepítési könyvtárat). Ha igazítani kell, szerkeszd benne a `User=`/`Group=` sort,
a `WorkingDirectory=`-t és a két abszolút útvonalat (`ExecStart=` és a `Documentation=`
sor), majd telepítsd:

```bash
sudo cp deploy/orchestrator.service /etc/systemd/system/orchestrator.service
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrator.service
```

Amit a generált unit már beállít helyetted:

- `User=` / `Group=` és `WorkingDirectory=` — **ugyanazzal a felhasználóval**
  futtasd, amelyik a `claude` előfizetéses bejelentkezést elvégezte és a
  telepítőt futtatta.
- Egy explicit `Environment=PATH=...`, amely **tartalmazza az npm-global bin
  könyvtárat**, ahol a `claude` CLI lakik (a szállított fájlban
  `~/.npm-global/bin`) — a systemd unitok nem öröklik a login shelled `PATH`-át,
  enélkül az ügynökök nem találnák meg a `claude`-ot. Továbbá
  `Environment=HOME=...`, hogy a `claude` CLI megtalálja az OAuth bejelentkezést
  a `~/.claude` alatt.
- `UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX`
  — a számlázást átkapcsoló tiltólista már a unit szintjén eltávolításra kerül,
  így egy szennyezett rendszerkörnyezet sem érheti el a supervisort. (Ezeket
  `Environment=`-mel **ne** add vissza; a supervisor megtagadja az indulást, ha
  bármelyik jelen van.)
- `Restart=on-failure`, valamint a `TimeoutStopSec` / **`KillMode=process`** —
  leállításkor vagy újraindításkor a systemd **kizárólag a supervisor folyamatot**
  öli meg, az ügynököket soha. Az ügynökök egy **dedikált tmux szerveren** futnak
  (`tmux -L citadel-mux`, a `runtime.claude.socket` állítja; ennek hiányában a
  `sessionPrefix`-re esik vissza), amely **nem a supervisor gyermekfolyamata**, így
  az ügynök-sessionök **túlélik a supervisor újraindítását**, és az új supervisor
  **adoptálja** őket — egyetlen ügynököt sem szakít meg egy újratelepítés. (Ezért
  is helyben-újrapörgetés a helyreállítás, és soha nem öli meg a szervert.)

**A supervisor leállítása vs. a flotta leállítása.** A `systemctl stop orchestrator`
(vagy egy újraindítás) csak a supervisort állítja le; az ügynökök tovább futnak a
dedikált tmux szerveren. A **flotta teljes leállításához** — minden ügynök-sessiont
beleértve — állítsd le explicit módon ezt a szervert:

```bash
tmux -L citadel-mux kill-server     # leállítja a dedikált socket minden ügynökét
```

(A socketet a `runtime.claude.socket`-ból vedd; a seed konfiguráció `citadel-mux`-ot
állít be. Ez csak a flotta saját szerverét érinti — a default szerveren futó saját
tmux-sessionjeidet nem.)

Az állapotkönyvtár áthelyezéséhez vedd fel az
`Environment=ORCHESTRATOR_STATE_DIR=/útvonal/az/állapothoz` sort (egyezzen a
telepítéskorival).

Megjegyzések:

- A root-jogú token csak a **legelső** induláskor (amikor a tokenfájl frissen
  jön létre) íródik stderr-re; minden későbbi indulás csak a dashboard URL-t
  és a 0600-as tokenfájl útvonalát naplózza, így a **journal** üzemszerűen
  token-mentes marad. Ha a legelső indulás systemd alatt történik, azt az
  egy `journalctl -u orchestrator` bejegyzést kezeld bizalmasként — vagy a tokent
  egyszerűen a `~/.orchestrator/dashboard-token` fájlból olvasd ki.
- Ha a dashboardot LAN-on vagy meshen (pl. Tailscale) szeretnéd elérhetővé
  tenni, állítsd be a `server.host`-ot a `<stateDir>/config.json`-ban a kívánt
  bind-címre (alapértelmezés szerint loopback, `127.0.0.1`). A token
  **root-jogú** — előbb olvasd el az 5. fejezetet a HTTPS-ről és a kitettségről.
- Állapotkönyvtáranként pontosan **egy** supervisor futhat — a unit
  engedélyezése előtt állíts le minden kézi `npm start`-ot (lásd a lockot a
  Hibakeresésnél).

## 5. HTTPS és hálózati kitettség — olvasd el, mielőtt portot nyitnál

A szerver alapértelmezés szerint **csak loopbackre** köt
(`127.0.0.1:7080`, lásd `server.host`/`server.port` a `config.json`-ban).
Hagyd is így, hacsak nem tudod pontosan, mit csinálsz:

- A dashboard token **root-jogú**: aki megszerzi, egy egész ágensflottát
  irányít, amelynek egyik tagja full-host biztonsági profillal fut a gépeden.
  A portot soha ne tedd ki közvetlenül LAN-ra vagy az internetre.
- Ha távoli elérés kell, használj **privát mesh VPN-t** (pl. Tailscale vagy
  WireGuard), és a bind maradjon loopbacken / a mesh interfészen, **vagy**
  tegyél elé **TLS-es** reverse proxyt (és a proxy originjét vedd fel a
  `config.json` `server.allowedOrigins` listájába, hogy az állapotváltoztató
  kérések átmenjenek az origin-ellenőrzésen).
- A **PWA-funkciókhoz HTTPS kell**: a service worker (offline shell,
  network-only `/api/*`) csak akkor regisztrálódik, ha a dashboard `https:`
  felett érkezik. Sima loopback HTTP-n a dashboard teljes értékűen működik,
  csak a telepíthető-app/offline-shell extrák nélkül.

## 6. Telegram-csatorna beállítása (opcionális, ajánlott)

A Telegram az 1-es verzió operátori csatornája. Az ismeretlen chatek
**alapértelmezésben tiltottak** — csak a beállított operátori chat van bekötve.

1. Telegramon írj a **@BotFather**-nek: `/newbot`, adj nevet és felhasználónevet,
   majd másold ki a kapott **bot tokent**.
2. Derítsd ki a saját **numerikus chat id**-dat (pl. írj a `@userinfobot`-nak,
   visszaküldi az azonosítódat).
3. A dashboardon nyisd meg a **Channels** nézetet, illeszd be a bot tokent,
   állítsd be az operátori chat id-t, kapcsold a csatornát **engedélyezettre**,
   majd mentsd el. A nyers token **titkosítva, a vaultban** tárolódik — a
   `config.json`-ba csak egy `vault:` hivatkozás kerül.
4. **Indítsd újra a supervisort** — a csatorna-változások a következő
   indításkor lépnek életbe (mentés után a dashboard ezt jelzi is).
5. Újraindítás után a Channels nézet **Test** gombjával ellenőrizd a tokent,
   majd írj egy üzenetet a botodnak.

## 7. Nyelv a telepítéskor — és módosítás később

- A telepítésszintű **alapértelmezett nyelv** (dashboard + backend szövegek;
  alapból magyar) telepítéskor dől el: interaktívan, vagy a `--locale hu|en`
  kapcsolóval.
- Minden eszköz bármikor átállíthatja a dashboard nyelvét a felső sáv
  **nyelvváltójával** (eszközönként megjegyzi).
- A telepítésszintű alapértelmezés később a **Settings** nézetben
  módosítható (élőben vált, újraindítás nem kell).
- Az **ágensek prózanyelve** — amilyen nyelven a jelentéseiket, dokumentumaikat
  írják — független tengely, szintén a Settingsben állítható. Fontos: a már
  lemezre került personák és operating contractok nem renderelődnek újra (az
  operátori szerkesztéseket a rendszer soha nem írja felül); az újonnan
  felvett ágensek már az új nyelvet kapják.

## 8. A telepítés ellenőrzése

```bash
npm run typecheck    # szigorú TS-ellenőrzés, tisztának kell lennie
npm test             # teljes futás: 1100+ unit + integrációs + boot/smoke teszt
```

## 9. Hibakeresés

**"… is set in this environment" / "… present in the environment"** (a
hibaüzenet az `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK` vagy `CLAUDE_CODE_USE_VERTEX` változót nevezi meg) —
a telepítő és a supervisor is megtagadja a futást, amíg a számlázást
átkapcsoló változók bármelyike be van állítva. Távolítsd el a shellből és a
profilfájlokból (lásd az [előfeltételeket](PREREQUISITES.hu.md)), nyiss új
shellt, próbáld újra. Systemd alatt a unit `Environment=` sorait is nézd át.

**"another supervisor is already running (pid …, since …)"** — egy
állapotkönyvtárhoz pontosan egy supervisor tartozhat. A `supervisor.lock`-ot
egy *élő* folyamat tartja; előbb azt állítsd le (`Ctrl-C`, `kill <pid>` vagy
`systemctl stop orchestrator`). A ténylegesen **árva** lockokat (halott pid,
pl. áramszünet után) a következő indulás magától felismeri és törli, a lock
megszerzése *után* elbukó indulás (pl. foglalt port) pedig kilépéskor maga
engedi el a lockot — a lockfájlt soha nem kell kézzel törölnöd.

**`startup failed: listen EADDRINUSE ... 127.0.0.1:7080`** — a portot másik
folyamat használja (gyakran egy másik állapotkönyvtárral elindult második
supervisor, vagy egy független szolgáltatás). Keresd meg
(`ss -ltnp | grep 7080`), állítsd le, vagy írd át a `server.port`-ot a
`~/.orchestrator/config.json`-ban, és indítsd újra.

**"tmux is required for the interactive agent runtime"** — telepítsd a tmuxot
(`sudo apt install tmux` / `brew install tmux`), és futtasd újra a telepítőt.

**"this Node build lacks the node:sqlite module"** — a Node-od régebbi
22.5-nél, vagy egy megnyirbált disztribúciós build. Telepíts hivatalos
Node >= 22.5-öt (lásd az [előfeltételeket](PREREQUISITES.hu.md)), és
ellenőrizd: `node -e "require('node:sqlite')"`.

**Az ágensek elindulnak, de bejelentkezést kérnek / a dashboard re-auth
szükségességét jelzi** — a Claude Code CLI telepítve van, de nincs (vagy már
nincs) bejelentkezve. Futtasd a `claude`-ot terminálban az orchestrator
felhasználójával, vidd végig az előfizetéses OAuth bejelentkezést, majd a
dashboardról indítsd újra az érintett ágenseket. A tmux sessionhöz
csatlakozva (`tmux -L citadel-mux attach -t citadel-<agent-id>`, a dedikált
socketen) helyben is elvégezheted a bejelentkezést.

**"npm ci failed"** — jellemzően hálózati/registry probléma; ellenőrizd a
kapcsolatot és az esetleges proxybeállításokat, majd futtasd újra a telepítőt
(idempotens).

**Elveszett a bootstrap URL** — a token lemezen van:
`cat ~/.orchestrator/dashboard-token`; az új eszközön nyisd meg egyszer a
`http://127.0.0.1:7080/?token=<ez az érték>` címet.
