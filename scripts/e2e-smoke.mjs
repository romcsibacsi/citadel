// CITADEL dashboard browser E2E smoke test.
//
// Plain node + playwright (no test runner). Launches headless chromium against
// the cached browser, drives the SPA served by scripts/e2e-web.ts, and writes
// screenshots + a JSON report to test-results/e2e/.
//
// Prereq: the harness must already be listening on 127.0.0.1:3420.
//   nohup npx tsx scripts/e2e-web.ts > /tmp/e2e-web.log 2>&1 &

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'test-results', 'e2e')
mkdirSync(OUT, { recursive: true })

const BASE = 'http://127.0.0.1:3420'
const TOKEN = 'e2e-token-citadel'

// Sidebar nav targets (data-page values), in sidebar order.
const SURFACES = [
  'overview', 'kanban', 'agents', 'activity', 'team', 'messages', 'tasks',
  'memories', 'recall', 'bgTasks', 'skills', 'connectors', 'migrate',
  'status', 'autonomy', 'vault', 'ideas', 'updates',
]
const THEMES = ['obsidian', 'stark', 'forge']

const report = {
  startedAt: new Date().toISOString(),
  chromiumVersion: null,
  surfaces: {},        // { [viewport]: { [surface]: { ok, visible, errors:[] } } }
  controls: {},
  themes: {},
  assets: {},
  mobile: {},
  networkErrors: [],    // 4xx/5xx responses observed (for intentional-404 notes)
  uncaughtConsole: [],  // anything not attributed to a surface window
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Per-page error wiring. `current` tracks which surface is active so async
// errors get attributed correctly.
function wireErrorCapture(page, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.push({ surface: sink.current, type: 'console', text: msg.text() })
  })
  page.on('pageerror', (err) => {
    sink.push({ surface: sink.current, type: 'pageerror', text: String(err && err.message || err) })
  })
  page.on('response', (res) => {
    const s = res.status()
    if (s >= 400) report.networkErrors.push({ surface: sink.current, url: res.url().replace(BASE, ''), status: s })
  })
}

async function gotoDashboard(page) {
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar', { state: 'visible', timeout: 15000 })
  await page.waitForSelector('.sb-link[data-page="overview"]', { timeout: 15000 })
  // Let the initial overview load + token bootstrap settle.
  await sleep(800)
}

async function sweepSurfaces(page, sink, viewport, screenshotFor) {
  const results = {}
  for (const surface of SURFACES) {
    sink.current = surface
    const before = sink.length
    let visible = false
    try {
      // Navigate via hash (drives switchPage); robust on both viewports even
      // when the sidebar is off-canvas on mobile.
      await page.evaluate((s) => { window.location.hash = s }, surface)
      await page.waitForFunction(
        (id) => { const el = document.getElementById(id); return !!el && !el.hidden },
        `${surface}Page`,
        { timeout: 8000 },
      )
      visible = true
    } catch (e) {
      sink.push({ surface, type: 'nav', text: `surface did not become visible: ${String(e.message || e)}` })
    }
    // Allow lazy fetches/renders to fire and any errors to surface.
    await sleep(600)
    const surfaceErrors = sink.slice(before).filter((x) => x.surface === surface)
    results[surface] = {
      ok: visible && surfaceErrors.length === 0,
      visible,
      errors: surfaceErrors.map((e) => `[${e.type}] ${e.text}`),
    }
    if (screenshotFor && screenshotFor.has(surface)) {
      await page.screenshot({ path: join(OUT, `${surface}-${viewport}.png`) }).catch(() => {})
    }
  }
  return results
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  report.chromiumVersion = browser.version()

  // ---------- DESKTOP ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const sink = []
    sink.current = 'boot'
    wireErrorCapture(page, sink)
    await gotoDashboard(page)

    report.surfaces.desktop = await sweepSurfaces(
      page, sink, 'desktop', new Set(['overview', 'kanban', 'agents']),
    )

    // ----- Controls (best-effort) -----
    const controls = {}

    // create-agent wizard opens
    try {
      sink.current = 'control:wizard'
      await page.evaluate(() => { window.location.hash = 'agents' })
      await page.waitForSelector('#addAgentBtn', { state: 'visible', timeout: 8000 })
      // Let loadAgents() finish its async render so the click doesn't race a
      // grid re-render.
      await sleep(600)
      await page.click('#addAgentBtn')
      await page.waitForSelector('#agentName', { state: 'visible', timeout: 5000 })
      const nameVisible = await page.isVisible('#agentName')
      controls.createWizardOpens = { ok: nameVisible }
      // close it
      await page.click('#wizardClose').catch(() => {})
    } catch (e) {
      controls.createWizardOpens = { ok: false, error: String(e.message || e) }
    }

    // name-suggestions endpoint (not wired into the wizard UI; probe directly)
    try {
      const r = await page.evaluate(async () => {
        const res = await fetch('/api/agents/name-suggestions?role=engineer')
        let body = null
        try { body = await res.json() } catch {}
        return { status: res.status, count: Array.isArray(body) ? body.length : (body && Array.isArray(body.names) ? body.names.length : null) }
      })
      controls.nameSuggestions = { ok: r.status === 200 && (r.count === null || r.count > 0), ...r, note: 'endpoint returns 200; not consumed by wizard UI' }
    } catch (e) {
      controls.nameSuggestions = { ok: false, error: String(e.message || e) }
    }

    // Tweaks panel toggle
    try {
      sink.current = 'control:tweaks'
      const hasToggle = await page.isVisible('#tweaksToggle')
      if (hasToggle) await page.click('#tweaksToggle')
      await sleep(400)
      controls.tweaksToggle = { ok: hasToggle }
    } catch (e) {
      controls.tweaksToggle = { ok: false, error: String(e.message || e) }
    }
    // dismiss any open tweaks popover via Escape
    await page.keyboard.press('Escape').catch(() => {})

    // kanban renders columns
    try {
      sink.current = 'control:kanban'
      await page.evaluate(() => { window.location.hash = 'kanban' })
      await page.waitForFunction(() => { const el = document.getElementById('kanbanPage'); return !!el && !el.hidden }, null, { timeout: 8000 })
      await sleep(500)
      const colCount = await page.evaluate(() => document.querySelectorAll('#kanbanPage .kanban-col, #kanbanPage [class*="kanban"]').length)
      controls.kanbanRenders = { ok: colCount > 0, columns: colCount }
    } catch (e) {
      controls.kanbanRenders = { ok: false, error: String(e.message || e) }
    }

    // chat/message input exists
    try {
      sink.current = 'control:messages'
      await page.evaluate(() => { window.location.hash = 'messages' })
      await page.waitForFunction(() => { const el = document.getElementById('messagesPage'); return !!el && !el.hidden }, null, { timeout: 8000 })
      await sleep(400)
      const hasInput = await page.evaluate(() => !!document.querySelector('#messagesPage input, #messagesPage textarea'))
      controls.messageInput = { ok: hasInput }
    } catch (e) {
      controls.messageInput = { ok: false, error: String(e.message || e) }
    }

    report.controls = controls

    // ----- Themes (on agents roster) -----
    sink.current = 'themes'
    await page.evaluate(() => { window.location.hash = 'agents' })
    await page.waitForFunction(() => { const el = document.getElementById('agentsPage'); return !!el && !el.hidden }, null, { timeout: 8000 })
    await sleep(600)
    for (const theme of THEMES) {
      const applied = await page.evaluate((t) => {
        window.__citadelSetTheme(t)
        return document.documentElement.getAttribute('data-theme')
      }, theme)
      await sleep(300)
      await page.screenshot({ path: join(OUT, `agents-${theme}.png`) }).catch(() => {})
      report.themes[theme] = { requested: theme, applied, ok: applied === theme }
    }
    // reset to default
    await page.evaluate(() => window.__citadelSetTheme('obsidian'))

    // ----- Assets: portraits / glyphs / favicon -----
    sink.current = 'assets'
    const assets = await page.evaluate(async () => {
      function probe(url) {
        return new Promise((resolve) => {
          const img = new Image()
          img.onload = () => resolve({ url, ok: img.naturalWidth > 0, w: img.naturalWidth })
          img.onerror = () => resolve({ url, ok: false, w: 0 })
          img.src = url + (url.includes('?') ? '' : `?t=${Date.now()}`)
        })
      }
      const portrait = await probe('/portraits/nexus.png')
      const glyph = await probe('/glyphs/nexus.png')
      // favicon: real network status
      let favStatus = null
      try { favStatus = (await fetch('/glyphs/nexus.png', { cache: 'no-store' })).status } catch {}
      // any real rendered portrait img on the roster
      const renderedPortraits = Array.from(document.querySelectorAll('img'))
        .filter((i) => i.src.includes('/portraits/'))
        .map((i) => ({ src: i.src.replace(location.origin, ''), w: i.naturalWidth }))
      return { portrait, glyph, favStatus, renderedPortraits }
    })
    report.assets = {
      portraitLoads: assets.portrait.ok,
      glyphLoads: assets.glyph.ok,
      faviconStatus: assets.favStatus,
      faviconOk: assets.favStatus === 200,
      renderedPortraitCount: assets.renderedPortraits.length,
      renderedPortraitWidthsOk: assets.renderedPortraits.length > 0 && assets.renderedPortraits.every((p) => p.w > 0),
      detail: assets,
    }

    sink.current = 'done-desktop'
    report.uncaughtConsole.push(...sink.filter((e) => e.surface === 'boot' || e.surface === 'done-desktop'))
    await ctx.close()
  }

  // ---------- MOBILE ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    const sink = []
    sink.current = 'boot'
    wireErrorCapture(page, sink)
    await gotoDashboard(page)

    // mobile sidebar open via hamburger
    let sidebarOpens = false
    try {
      sink.current = 'mobile:menu'
      await page.waitForSelector('#mobileMenuBtn', { timeout: 8000 })
      await page.click('#mobileMenuBtn')
      await page.waitForFunction(
        () => { const sb = document.querySelector('.sidebar'); return !!sb && sb.classList.contains('open') },
        null, { timeout: 5000 },
      )
      sidebarOpens = true
      // close it again so it doesn't cover the surface sweep
      const backdrop = await page.$('#sidebarBackdrop')
      if (backdrop) await backdrop.click().catch(() => {})
      else await page.click('#mobileMenuBtn').catch(() => {})
      await sleep(300)
    } catch (e) {
      sink.push({ surface: 'mobile:menu', type: 'nav', text: String(e.message || e) })
    }
    report.mobile.sidebarOpens = sidebarOpens

    report.surfaces.mobile = await sweepSurfaces(
      page, sink, 'mobile', new Set(['overview', 'agents']),
    )

    report.uncaughtConsole.push(...sink.filter((e) => e.surface === 'boot' || e.surface === 'mobile:menu'))
    await ctx.close()
  }

  await browser.close()

  // ----- Summarize -----
  const summarize = (vp) => {
    const s = report.surfaces[vp] || {}
    const total = Object.keys(s).length
    const passed = Object.values(s).filter((x) => x.ok).length
    return { total, passed, failed: total - passed }
  }
  report.summary = {
    desktop: summarize('desktop'),
    mobile: summarize('mobile'),
    themesAllApplied: THEMES.every((t) => report.themes[t]?.ok),
    assetsOk: report.assets.portraitLoads && report.assets.glyphLoads && report.assets.faviconOk,
    mobileSidebar: report.mobile.sidebarOpens,
  }
  report.finishedAt = new Date().toISOString()

  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  // Console digest
  console.log('\n===== CITADEL E2E SMOKE =====')
  console.log('chromium:', report.chromiumVersion)
  for (const vp of ['desktop', 'mobile']) {
    console.log(`\n--- ${vp} surfaces (${report.summary[vp].passed}/${report.summary[vp].total}) ---`)
    for (const [name, r] of Object.entries(report.surfaces[vp] || {})) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${name}${r.errors.length ? '  :: ' + r.errors.join(' | ') : ''}`)
    }
  }
  console.log('\n--- controls ---')
  for (const [name, r] of Object.entries(report.controls)) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${name}${r.error ? '  :: ' + r.error : ''}`)
  }
  console.log('\n--- themes ---')
  for (const t of THEMES) console.log(`  ${report.themes[t]?.ok ? 'PASS' : 'FAIL'}  ${t} -> ${report.themes[t]?.applied}`)
  console.log('\n--- assets ---')
  console.log('  portrait:', report.assets.portraitLoads, '| glyph:', report.assets.glyphLoads, '| favicon:', report.assets.faviconStatus, '| renderedPortraits:', report.assets.renderedPortraitCount)
  console.log('\n--- mobile sidebar opens:', report.mobile.sidebarOpens)
  console.log('\n--- network 4xx/5xx ---')
  const uniq = new Map()
  for (const n of report.networkErrors) uniq.set(n.url + ' ' + n.status, n)
  for (const n of uniq.values()) console.log(`  ${n.status}  ${n.url}  (surface: ${n.surface})`)
  console.log('\nreport.json + screenshots ->', OUT)
}

main().catch((e) => { console.error('SMOKE CRASHED:', e); process.exit(1) })
