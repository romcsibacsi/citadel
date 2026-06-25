# Előfeltételek

> English version: [PREREQUISITES.en.md](PREREQUISITES.en.md)

Ez a dokumentum az orchestrator **összes** előfeltételét sorolja fel: minimum- és
tesztelt verziókkal, konkrét telepítő parancsokkal és az ellenőrzés módjával. A
telepítő (`scripts/install.sh`) ugyanezeket az előfeltételeket ellenőrzi, és
hiányzó vagy inkompatibilis komponensnél azonnal, érthető hibaüzenettel áll le —
de ha előbb ezt az oldalt olvasod végig, megspórolod a köröket.

Ha minden megvan, folytasd a [telepítési útmutatóval](INSTALL.hu.md).

## Összefoglaló

| Előfeltétel | Minimum | Tesztelt | Mire kell |
|---|---|---|---|
| OS / architektúra | Linux x64 | Ubuntu 24.04, kernel 6.8 | Gazdagép (macOS-en várhatóan működik, nem tesztelt) |
| Node.js | 22.5 | 22.22 | Futtatókörnyezet; a beépített `node:sqlite` modulhoz >= 22.5 kell |
| npm | a Node-dal érkezik | 10.x | Függőségek telepítése, build szkriptek |
| tmux | 3.x | 3.4 | Az interaktív ágens-futtatás alapja |
| Claude Code CLI (`claude`) | 2.x | 2.1.x | Maguk az ágensek — interaktív, előfizetéses sessionök |
| `ANTHROPIC_API_KEY` és társai | **NEM lehet beállítva** | — | Előfizetéses számlázás védelme — a számlázást átkapcsoló változók tiltólistája (lásd lent) |

**Más futásidejű függőség nincs:** a projektnek nulla npm runtime csomagja van
(csak fejlesztői eszközök), az SQLite magában a Node-ban van beépítve
(`node:sqlite`), külső adatbázisra, üzenetsorra vagy webszerverre nincs szükség.

## Operációs rendszer és architektúra

- **Linux x64** a támogatott és tesztelt platform (tesztelve: Ubuntu 24.04,
  6.8-as kernel).
- **macOS**-en várhatóan működik — minden használt komponens (Node, tmux, Claude
  Code CLI) elérhető rajta —, de ez **nem tesztelt**.
- **Windows** *natívan* nem támogatott (az ágens-futtatás tmux-ra épül, amelynek
  nincs natív Windows-buildje) — de **WSL2 alatt teljesen működik**, és ez az
  ajánlott mód Windows gépen. Lépésről lépésre lent.

## Futtatás Windowson WSL2-vel (lépésről lépésre)

A WSL2 (Windows Subsystem for Linux) egy valódi Ubuntu Linuxot ad *a Windowson
belül* (Windows 10/11) — a tmux, a Node és a bash mind működik benne, így a CITADEL
pontosan úgy fut, mint Linuxon. Nincs dual-boot, nincs kézzel bütykölt virtuális gép.

1. **Kapcsold be a WSL2-t + telepíts Ubuntut.** Nyiss egy **PowerShell-t
   rendszergazdaként** (Start → írd be: "PowerShell" → jobb klikk → *Futtatás
   rendszergazdaként*), majd futtasd:
   ```powershell
   wsl --install -d Ubuntu
   ```
   Indítsd újra a gépet, ha kéri. Az Ubuntu első indításakor kér egy felhasználónevet
   és jelszót — add meg (ez a Linux-bejelentkezésed, külön a Windowsétól).
2. **Nyisd meg az Ubuntut** (Start → "Ubuntu"). Most már van egy Linux-terminálod.
   Frissítsd:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```
3. **Innentől kövesd a dokumentum normál Linux-telepítését** — telepítsd a Node
   ≥ 22.5-öt, a tmux-ot és a Claude Code CLI-t (a lenti szakaszok), majd futtasd a
   `./scripts/install.sh`-t. Minden pontosan úgy viselkedik, mint egy natív Linux gépen.

Jó tudni:
- A projekt-fájljaid az Ubuntu home-ban (`~`) élnek; a Windows Explorerből is eléred
  őket a `\\wsl$\Ubuntu\home\<a-neved>` címen.
- A WSL2-höz Windows 10 2004+ vagy Windows 11 kell.
- (Opcionális) a kép/videó-generáláshoz egy GPU-s ComfyUI kell — ez lehet ugyanennek
  a Windows gépnek a GPU-ja WSL2-ből elérve, vagy egy külön gép.

## Node.js >= 22.5 (a `node:sqlite` modullal)

Az orchestrator minden állapotát a Node beépített SQLite modulján
(`node:sqlite`) keresztül tárolja, amely a Node 22.5-ben jelent meg. **Hivatalos
Node buildet** használj — egyes disztribúciós buildekből hiányzik a modul.
Tesztelve a Node 22.22-vel.

Telepítés — válassz egyet:

**NodeSource csomagok (Debian/Ubuntu):**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**nvm (bármilyen Linux/macOS, root nélkül):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# nyiss új shellt, majd:
nvm install 22
nvm use 22
```

**Hivatalos telepítő/binárisok:** <https://nodejs.org>.

Ellenőrizd a verziót és az SQLite modult is:

```bash
node --version                      # v22.5.0 vagy újabb kell
node -e "require('node:sqlite')"    # csendben, hiba nélkül kell kilépnie
```

## npm

Az npm a Node.js-szel együtt érkezik — a fenti Node-telepítéssel az npm is
megvan. Ellenőrzés:

```bash
npm --version
```

## tmux >= 3.x

Minden ágens egy valódi, interaktív Claude Code sessionként fut egy-egy tmux
sessionben; a supervisor ezeket hozza létre, figyeli és gépel beléjük.
Tesztelve a tmux 3.4-gyel.

```bash
# Debian/Ubuntu
sudo apt install tmux

# macOS
brew install tmux
```

Ellenőrzés:

```bash
tmux -V    # pl. "tmux 3.4"
```

## Claude Code CLI, előfizetéses OAuth bejelentkezéssel

Az ágensek interaktív Claude Code sessionök, amelyek a **Claude-előfizetésed**
(Pro/Max) terhére futnak. Tesztelve a Claude Code 2.1.x-szel.

Telepítés:

```bash
npm install -g @anthropic-ai/claude-code
```

Ezután **egyszer** jelentkezz be — ugyanazzal az OS-felhasználóval, amelyik
majd az orchestratort futtatja:

```bash
claude
```

Elindul egy interaktív session; első futáskor végigvezet az OAuth
bejelentkezésen — az **előfizetéses** (claude.ai fiókos) bejelentkezést
válaszd, *ne* az API-kulcsosat. A hitelesítő adat helyben tárolódik, és minden
ágens-session ezt használja újra.

Ellenőrzés:

```bash
claude --version    # pl. 2.1.x
```

majd indítsd el még egyszer a `claude`-ot: az interaktív sessionnek **API-kulcs
vagy bejelentkezés kérése nélkül** kell megnyílnia. (A telepítő csak a `claude`
bináris meglétét ellenőrzi — maga a bejelentkezés az első ágens-session
indulásakor derül ki élesben.)

## Nincsenek számlázást átkapcsoló változók — ellenőrizd!

Ez a rendszer **kizárólag előfizetéses számlázással** működik. A Claude Code
CLI még az interaktív sessionöket is csendben átkapcsolja **fogyasztásalapú,
fizetős vagy külső számlázásra**, ha az alábbi változók bármelyike jelen van —
egy egész ágensflotta egy ottfelejtett hitelesítő adaton nagyon gyorsan nagyon
drága tud lenni:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `CLAUDE_CODE_USE_BEDROCK`
- `CLAUDE_CODE_USE_VERTEX`

Ezt a tiltólistát (`src/core/billing.ts`) a rendszer három helyen kényszeríti
ki: a telepítő és a supervisor is **keményen megtagadja az indulást**, ha
bármelyik be van állítva, és ráadásul minden ágens-indítás `env -u`-val le is
választja mind a négyet.

Ellenőrizd, hogy egyik sincs jelen:

```bash
env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE'    # semmit nem szabad kiírnia
```

Ha bármit kiír, távolítsd el a változókat az aktuális shellből **és** a shell
profilfájljaidból (`~/.bashrc`, `~/.profile`, `~/.zshrc` stb.), majd nyiss új
shellt, és ellenőrizd újra:

```bash
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
grep -rnE "ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE" ~/.bashrc ~/.profile ~/.zshrc 2>/dev/null
```

Ha később systemd alatt futtatod a supervisort, figyelj rá, hogy a unit
`Environment=` sorai se hozzák be ezeket a változókat.

## Opcionális / elhalasztott backendek

**Egyik sem szükséges.** Az embedding backend (szemantikus memóriakeresés) és a
médiagenerálási backend ebben a verzióban **elhalasztott (deferred) modul** — a
rendszer nélkülük teljes értékűen fut, opcionális szolgáltatást nem kell
telepíteni vagy konfigurálni.

## Gyors ellenőrzés — minden egyben

```bash
node --version && node -e "require('node:sqlite')" && \
npm --version && \
tmux -V && \
claude --version && \
{ env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE' && echo "HIBA: távolítsd el a fenti számlázási változókat" || echo "OK: nincs számlázást átkapcsoló változó"; }
```

Ha a fentiek mind sikeresek, folytasd a [telepítési útmutatóval](INSTALL.hu.md).
