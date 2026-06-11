/* CITADEL service worker — Phase 7A
 * --------------------------------------------------------------------------
 * Strategy:
 *   - Cache-first for the static app shell + assets (versioned cache).
 *   - NETWORK-ONLY for /api/* — API responses are NEVER cached or served from
 *     cache, so stale agent/task/session data can never be shown. The SW
 *     simply does not intercept these (falls through to the network), which
 *     also keeps the ?token= bootstrap and Bearer auth flow untouched.
 *   - activate purges any cache whose name != the current version.
 * Registration is fail-soft from app.js; if anything here throws the app
 * still works as a plain online SPA.
 */
const CACHE_VERSION = 'citadel-v3'
const PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/themes.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  // Pre-cache the shell. addAll is atomic-ish; if a single asset 404s the
  // whole install rejects, so keep PRECACHE to assets we know are served.
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* fail-soft: a missing precache asset must not brick the SW */
      }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  // Only handle GET; never touch POST/PUT/etc.
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }

  // Same-origin only — leave cross-origin (e.g. font CDNs handled below) and
  // anything we don't recognise to the browser default.
  const sameOrigin = url.origin === self.location.origin

  // NETWORK-ONLY for the API. Do not intercept at all → straight to network,
  // never cached, never served stale.
  if (sameOrigin && url.pathname.startsWith('/api/')) return

  // Cache-first for same-origin static assets and the app shell.
  if (sameOrigin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit
        return fetch(req)
          .then((res) => {
            // Cache successful, basic (same-origin) responses opportunistically.
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone()
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy))
            }
            return res
          })
          .catch(() => caches.match('/index.html'))
      }),
    )
    return
  }

  // Cross-origin GET (Google Fonts CSS + font files, CDN libs): cache-first so
  // the app degrades gracefully offline once fonts have been fetched once.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit
      return fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone()
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy))
          }
          return res
        })
        .catch(() => hit)
    }),
  )
})
