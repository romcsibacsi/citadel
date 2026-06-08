// Focused theme screenshot: agents page under each theme. Assumes the e2e-web
// harness is serving on 127.0.0.1:3420 with DASHBOARD_TOKEN=e2e-token-citadel.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const TOKEN = process.env.DASHBOARD_TOKEN || 'e2e-token-citadel'
const OUT = 'test-results/e2e'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()) })

await page.goto(`http://127.0.0.1:3420/?token=${TOKEN}`, { waitUntil: 'networkidle' })
await page.waitForSelector('.sidebar', { timeout: 15000 })
// navigate to agents
await page.evaluate(() => { location.hash = '#agents' })
await page.waitForTimeout(1200)

for (const theme of ['obsidian', 'stark', 'forge']) {
  await page.evaluate((t) => window.__citadelSetTheme(t), theme)
  await page.waitForTimeout(900)
  const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  await page.screenshot({ path: `${OUT}/fidelity-${theme}.png` })
  console.log(`theme=${theme} applied=${applied} -> ${OUT}/fidelity-${theme}.png`)
}
await browser.close()
console.log('done')
