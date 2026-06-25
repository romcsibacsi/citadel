# A saját MCP connectorod bekötése

Egy **MCP szerver** extra eszközöket ad az ügynököknek (fájlrendszer, adatbázis, egy
SaaS API, …). A CITADEL a **Connectors** nézetből kezeli a connectorokat (csak operátor).
Ez az útmutató az alkalmazáson belüli súgópanelt tükrözi.

## A két szabványos forma

### stdio (helyi parancs)
Az ügynök **elindít egy helyi folyamatot**, és stdin/stdout-on beszél vele.

- **Parancs** — a futtatható, pl. `npx -y @modelcontextprotocol/server-filesystem`
- **Argumentumok** — opcionális, pl. `/data`
- A parancs **ezen a gépen** fut, tehát telepítve / a `PATH`-on kell lennie. Használd a
  **Teszt** gombot — ellenőrzi, hogy a parancs feloldható-e (soha nem futtatja le).

### HTTP / SSE (távoli szerver)
Az ügynök egy **URL-en** keresztül éri el a szervert.

- **URL** — a `https://` végpont, pl. `https://mcp.example.com/mcp`
- Az autentikáció (ha van) egy **env változóként** adható meg (lásd Titkok). Használd a
  **Teszt** gombot — korlátozott HTTP GET-et küld; egy `2xx`, `401`, `403` vagy `405` is
  bizonyítja, hogy a végpont válaszolt.

## Titkok

A connector űrlapján csak az env változó **NEVÉT** add meg. Az **ÉRTÉK** a **Vaultba**
kerül, és a connectorral soha nem tárolódik vagy naplózódik. A **Teszt** gomb soha nem
küldi el a titkaidat — csak az elérhetőséget / parancs-feloldást vizsgálja.

## Hozzárendelés + engedélyezés/letiltás

- Egy **projekt-scope-ú** connector adott al-ügynökökhöz **rendelhető**; a hubnak mindig
  van hozzáférése.
- Minden connectornak van **Engedélyez / Letilt** kapcsolója — kikapcsolhatod törlés
  nélkül. A letiltott connector halványítva, áthúzva jelenik meg a listában.

## Példák

**stdio (fájlrendszer):**
- Parancs: `npx -y @modelcontextprotocol/server-filesystem`
- Args: `/data`

**HTTP (bearer tokennel):**
- URL: `https://mcp.example.com/mcp`
- Env változó: `MCP_TOKEN` (az érték a Vaultban, a szerver-konfigod küldi az
  `Authorization: Bearer …` fejlécként)

## Megjegyzések

- Az élő `claude mcp` szkennelés egy varrat mögött van; a **Frissítés** csak a cache
  időbélyegét írja. Amit itt hozzáadsz, az perzisztens.
- Ne add hozzá helyben újra, amit a Claude előfizetésedben fent már engedélyeztél —
  duplikál, és a CLI figyelmeztet, hogy „local wins".
