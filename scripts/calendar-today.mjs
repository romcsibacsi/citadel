#!/usr/bin/env node
// Prints today's remaining Google Calendar events as plain text, for the morning
// briefing (reggeli-napindito). Reuses src/google-api.ts (dist) getCalendarEvents,
// which reads ~/.config/google-calendar-mcp/tokens.json + ~/.gmail-mcp/gcp-oauth.keys.json
// and self-refreshes. Read-only. Calendar id: argv[2] or HEARTBEAT_CALENDAR_ID (.env) or 'primary'.
// Output: one line per event, or nothing (briefing skips the section if empty/erroring).
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
function envCalendarId() {
  try {
    for (const line of readFileSync(join(here, '..', '.env'), 'utf-8').split('\n')) {
      const m = line.match(/^HEARTBEAT_CALENDAR_ID=(.*)$/)
      if (m && m[1].trim()) return m[1].trim()
    }
  } catch { /* no .env */ }
  return 'primary'
}

const calId = process.argv[2] || envCalendarId()
const { getCalendarEvents } = await import(join(here, '..', 'dist', 'google-api.js'))

const now = new Date()
const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999)

const events = await getCalendarEvents(calId, now, endOfDay)
const fmt = (e) => {
  if (e.start?.dateTime) {
    const t = new Date(e.start.dateTime).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Budapest' })
    return `• ${t} ${e.summary || '(cím nélkül)'}${e.location ? ` (${e.location})` : ''}`
  }
  return `• egész nap: ${e.summary || '(cím nélkül)'}` // all-day event (start.date)
}
for (const e of events) console.log(fmt(e))
