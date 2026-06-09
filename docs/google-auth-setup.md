# Google auth a napindítóhoz (naptár, read-only, headless)

A reggeli napindító + a heartbeat triage a Google Naptáradat a `src/google-api.ts`
`getCalendarEvents()`-en át olvassa. Ez **headless** működik (egyszer authentikálsz, utána
a `refresh_token`-ből magát frissíti). Két fájl kell:

- `~/.gmail-mcp/gcp-oauth.keys.json` — az OAuth **kliens** (client_id/secret). Ezt TE hozod létre a Google Cloudban (lentebb).
- `~/.config/google-calendar-mcp/tokens.json` — a **token** (`{ normal: { ...refresh_token... } }`). Ezt a setup-script írja.

Scope: **csak `calendar.readonly`** (olvasás; sosem ír).

## 1. lépés — OAuth kliens a Google Cloud Console-ban (~5 perc, a TE fiókodban)

1. https://console.cloud.google.com → hozz létre (vagy válassz) egy projektet.
2. **APIs & Services → Library** → keresd: *Google Calendar API* → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User Type: **External** → Create.
   - App name + a saját email-ed (support + developer contact).
   - **Test users**: add hozzá a saját Google-fiókod (amelyik naptárát olvasni akarod).
   - ⚠️ **FONTOS (különben 7 nap múlva lejár a token):** a *Publishing status*-t állítsd **"In production"**-re (**Publish app**). A `calendar.readonly` „sensitive" scope, de a saját, egyfelhasználós appodnál a Google-verifikáció nélkül is publikálhatod — a consentnél megjelenő „unverified app" figyelmeztetést elfogadod. Ha **Testing** állapotban hagyod, a refresh_token kb. **7 naponta lejár** és újra kell authentikálni.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app** → név → Create.
   - **Download JSON.**
5. Mentsd a letöltött JSON-t ide: **`~/.gmail-mcp/gcp-oauth.keys.json`** (a tartalma `{ "installed": { "client_id", "client_secret", "token_uri", ... } }`).

## 2. lépés — egyszeri jóváhagyás (a setup-script)

```bash
cd /home/uplinkfather/CITADEL/citadel
node scripts/google-auth-setup.mjs
```
- Kiír egy consent-URL-t. Nyisd meg böngészőben, jelentkezz be a fiókkal, fogadd el (az „unverified app"-nál: Advanced → Continue).
- **Ha a böngésződ ezen a gépen fut:** a script magától elkapja a kódot (`http://localhost:42813`).
- **Ha más gépen:** a jóváhagyás után a böngésző egy nem-betöltődő `http://localhost:42813/...` oldalra ugrik — másold ki a címsorból a teljes URL-t (vagy csak a `code=` értéket), illeszd be a terminálba, Enter.
- A script a `~/.config/google-calendar-mcp/tokens.json`-ba írja a tokent (`{ normal: {...} }` formátum).

## 3. lépés — naptár-azonosító + restart

- A `.env`-ben már be van állítva: `HEARTBEAT_CALENDAR_ID=primary` (az elsődleges naptárad). Ha másik naptárat akarsz, írd át a naptár email-címére.
- Indítsd újra a dashboardot, hogy beolvassa: `systemctl --user restart nexus-dashboard`.

## 4. lépés — ellenőrzés

- A `store/dashboard.log`-ban megszűnik a percenkénti `Heartbeat: calendar fetch failed` / ENOENT spam.
- A reggeli napindító mostantól mutatja a mai naptár-eseményeket (a `reggeli-napindito` `07:30`-kor fut; azonnali teszt: a Telegram/Discord `/napindito` parancs, vagy kérd NEXUS-tól).

## Megjegyzések

- **Read-only**: a scope csak olvasás; az ügynök nem módosíthatja a naptáradat.
- **Önfrissítés**: a `getCalendarEvents()` lejárat előtt 5 perccel frissít a `refresh_token`-ből; a tokens.json mtime-alapú cache miatt egy újra-auth azonnal érvényesül.
- **Újra-auth** (ha visszavontad a hozzáférést, vagy lejárt): futtasd újra a 2. lépést.
- **Email a napindítóba**: jelenleg NINCS (a `google-api.ts` csak naptárat tud). Ha kell, külön getRecentEmails() Gmail-lekérő írható ugyanerre az OAuth-ra (gmail.readonly scope) — szólj.
