#!/usr/bin/env node
// One-time Google OAuth setup for the morning briefing / heartbeat calendar.
//
// Prereq: a Google "Desktop app" OAuth client JSON at ~/.gmail-mcp/gcp-oauth.keys.json
// (see docs/google-auth-setup.md). This script runs the OAuth consent flow and writes
// the refresh token to ~/.config/google-calendar-mcp/tokens.json in the exact shape
// src/google-api.ts expects ({ normal: { access_token, refresh_token, expiry_date,
// token_type, scope } }). After that, getCalendarEvents() self-refreshes forever.
//
// Scope: calendar.readonly only (read the calendar; never write).
//
// Works headless: it starts a loopback listener AND accepts a pasted code, so it
// works whether your browser is on this machine or another (copy the code= from the
// redirected URL and paste it).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'

const CLIENT_PATH = join(homedir(), '.gmail-mcp', 'gcp-oauth.keys.json')
const TOKENS_PATH = join(homedir(), '.config', 'google-calendar-mcp', 'tokens.json')
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const PORT = Number(process.env.PORT || 42813)
const REDIRECT = `http://localhost:${PORT}`

function die(msg) { console.error('ERROR:', msg); process.exit(1) }

let creds
try { creds = JSON.parse(readFileSync(CLIENT_PATH, 'utf-8')).installed } catch { die(`Nincs vagy hibás OAuth kliens: ${CLIENT_PATH}\nHozd létre a docs/google-auth-setup.md szerint.`) }
if (!creds?.client_id || !creds?.client_secret) die(`A ${CLIENT_PATH}-ból hiányzik az installed.client_id / client_secret.`)
const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token'

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: creds.client_id,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
}).toString()

console.log('\n1) Nyisd meg ezt a böngésződben és hagyd jóvá (csak naptár-olvasás):\n')
console.log(authUrl)
console.log(`\n2a) Ha a böngésződ EZEN a gépen fut: a jóváhagyás után magától elkapom a kódot (${REDIRECT}).`)
console.log('2b) Ha MÁS gépen: a jóváhagyás után a böngésző egy nem-betöltődő', REDIRECT, 'oldalra ugrik —')
console.log('    másold ki a címsorból a teljes URL-t (vagy csak a code= értékét) és illeszd be ide, Enter.\n')

const extractCode = (s) => { try { return new URL(s.trim()).searchParams.get('code') } catch { const m = s.trim().match(/[?&]code=([^&\s]+)/); return m ? decodeURIComponent(m[1]) : s.trim() } }

// Race: loopback listener vs pasted code.
const viaServer = new Promise((resolve) => {
  const srv = createServer((req, res) => {
    const code = new URL(req.url, REDIRECT).searchParams.get('code')
    res.end(code ? 'CITADEL: megvan a kód, visszatérhetsz a terminálhoz.' : 'Nincs code paraméter.')
    if (code) { srv.close(); resolve(code) }
  })
  srv.on('error', () => {/* port busy -> rely on paste */})
  srv.listen(PORT, '127.0.0.1')
})
const viaPaste = new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (l) => { if (l.trim()) { rl.close(); resolve(extractCode(l)) } })
})

const code = await Promise.race([viaServer, viaPaste])
if (!code) die('Nem érkezett kód.')

const res = await fetch(tokenUri, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: creds.client_id, client_secret: creds.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }).toString(),
})
const tok = await res.json()
if (!res.ok || !tok.refresh_token) die(`Token-csere sikertelen: ${res.status} ${JSON.stringify(tok)}\n(Ha nincs refresh_token: vond vissza a hozzáférést a Google fiókban és futtasd újra — a prompt=consent kell hozzá.)`)

mkdirSync(dirname(TOKENS_PATH), { recursive: true })
writeFileSync(TOKENS_PATH, JSON.stringify({ normal: {
  access_token: tok.access_token,
  refresh_token: tok.refresh_token,
  expiry_date: Date.now() + (tok.expires_in * 1000),
  token_type: tok.token_type || 'Bearer',
  scope: tok.scope || SCOPE,
} }, null, 2))
console.log(`\n✅ Kész. Token mentve: ${TOKENS_PATH}`)
console.log('Még egy lépés, ha nincs beállítva: .env -> HEARTBEAT_CALENDAR_ID=primary (vagy a naptárad email-címe), majd dashboard restart.')
process.exit(0)
