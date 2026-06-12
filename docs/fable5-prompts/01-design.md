# Fable 5 — Design system: build the CITADEL visual identity (ORIGINAL CSS from this spec)

Clean-room: build from THIS spec only; do NOT look at any existing stylesheet. Author your OWN
original CSS using CSS custom properties (design tokens). The look below is the product owner's own
design — reproduce its visual language faithfully, but the CSS is your original code.

You already have a theme system (tokens + a runtime theme switcher + arcane/daylight). EXTEND it to
the full design below. Keep the runtime language switcher untouched.

## 1. App shell / layout
- A CSS-grid shell: a FIXED 220px LEFT SIDEBAR + a 1fr MAIN column. Base font-size 15px, line-height 1.5.
- SIDEBAR (sticky, 100vh, background = --bg-card, 1px right border, padding ~20px 14px, flex column):
  - TOP: brand block = a small square logo glyph + the product name (display font, bold) + a tiny
    "online" status line under it.
  - NAV (flex column, gap 2px, scrollable, flex:1): each item = icon + label, padding ~8px 10px,
    radius-sm, muted color, 14px/500. ACTIVE item = accent-colored text + an accent-soft tinted
    background pill + a soft accent glow (glow scales with --glow). Hover = subtle raise.
  - FOOTER (bottom): a light/dark (theme) quick-toggle + a settings/"Tweaks" gear button.
- MAIN (scrollable): a PAGE-HEADER at top = h1 title (display font) + a muted one-line subtitle,
  ~32px bottom margin; then the view content.
- Responsive: on narrow screens the sidebar collapses (drawer or top bar); content reflows.

## 2. Token CONTRACT (every component reads ONLY these; themes just remap them)
Core (~30): --bg, --bg-card, --bg-card-hover, --bg-input, --bg-modal, --bg-code; --text,
--text-secondary, --text-muted; --border, --border-focus; --accent, --accent-hover, --accent-soft;
--danger, --danger-soft, --danger-hover; --success, --success-soft; --info, --info-soft;
--shadow-sm, --shadow-md, --shadow-lg; --radius, --radius-sm, --radius-lg; --transition.
Extended: --font-display, --font-body, --font-mono; --glow (0..1); --ac (per-agent accent, default
per theme); --accent-violet, --accent-gold (decoration accents).

## 3. Themes — ship FIVE; DEFAULT = "obsidian". Switch at runtime, no reload, persisted.

OBSIDIAN COMMAND (DEFAULT — dark, dual cyan+violet, gold decoration):
  bg #0A0A12 · bg-card #14141F · bg-card-hover #1B1B28 · bg-input #0F0F1A · bg-modal #14141F · bg-code #06060B
  text #ECECF4 · text-secondary #A6A6BC · text-muted #6C6C84 · border #262633
  accent/border-focus #34D6F0 (cyan) · accent-hover #74ECFF · accent-soft rgba(52,214,240,.12)
  danger #FF5067 · success #41E0A3 · info #4F8CFF · ac #9B79FF (violet) · accent-gold #F2C879
  radius 10/6/14 · transition .24s cubic-bezier(.2,.8,.2,1) · glow 0.6
  fonts: display "Space Grotesk", body "IBM Plex Sans", mono "IBM Plex Mono"
  ambient: two faint fixed radial washes behind the app — cyan from top-right, violet from bottom-left.

STARK HUD (cyan arc-reactor HUD):
  bg #070C13 · bg-card #0A111B · bg-card-hover #132235 · bg-input #0E1825 · bg-code #04070C
  text #EAF4FF · text-secondary #8499AE · text-muted #54677C · border rgba(120,196,255,.12)
  accent #46E6FF · accent-hover #8BF4FF · danger #FF5468 · success #3DF0C0 (jade) · info #1893C2 · ac #46E6FF
  radius 6/4/10 (sharper) · glow 0.7 · fonts: display "Rajdhani", body "Chakra Petch", mono "Share Tech Mono"
  SIGNATURE: a faint technical GRID backdrop (fixed); CORNER-BRACKET reticles on cards/stat-cards;
  mono UPPERCASE instrument labels (stat/meta labels, badges, model badges) with letter-spacing;
  glowing section headers + arc-reactor stat values (cyan text-shadow); hairline cyan edges.

ARCANE FORGE (gold + ember on warm obsidian):
  bg #110E0A · bg-card #1D1812 · bg-card-hover #2C241A · bg-input #0E0B08 · bg-code #17130D
  text #EDE2CC (parchment) · text-secondary #C5B79C · text-muted #94886F · border #3A3022
  accent #E6B249 (gold) · accent-hover #F6D27A · danger #D24430 (crimson) · success #6FAE84 · info #6FB0B8
  ac #F0822E (ember) · radius 7/5/10 · glow 0.5 · fonts: display "Cinzel" (serif), body "IBM Plex Sans", mono "IBM Plex Mono"
  ambient: warm ember/gold radial washes.

LIGHT (warm parchment):
  bg #FAF9F5 · bg-card #FFFFFF · bg-card-hover #F5F4ED · bg-input #F0EEE6 · text #141413 ·
  text-muted #87867F · border #D1CFC5 · accent #D97757 (coral) · danger #BF4D43 · success #788C5D ·
  info #6A9BCC · radius 12/8/16 · fonts: system sans body, mono "JetBrains Mono".

DARK: a neutral dark fallback derived from the same contract (cool grey-blue, system fonts).

## 4. Signature visual treatments
- PER-AGENT ACCENT: every agent has an accent color (from config). Set it as inline --ac on that
  agent's card/avatar; the rim, glow and accents derive from --ac.
- FRAMED AVATAR (the signature element): a clean portrait/glyph image on a TINTED DARK RADIAL DISC,
  circular-cropped; a 2px solid --ac RIM with an inset shadow painted over the image; an OUTER accent
  GLOW whose size scales with --glow (not clipped). Theme flourishes: OBSIDIAN = a slow rotating
  conic "rune sweep" around the rim (~7s, intensity tracks --glow); STARK = corner-bracket targeting
  reticle around the disc. ALWAYS honor prefers-reduced-motion (no sweep).
- GLOW is a first-class, user-adjustable variable (--glow 0..1): scales avatar rings, active-nav
  glow, and focus rings.

## 5. Component inventory (re-skin purely from tokens)
- STAT CARDS: a big accent-colored number (display/mono) + a small UPPERCASE muted label; used in a
  top row on the overview. (Stark: corner brackets + glowing value.)
- AGENT CARD: framed avatar + name (display) + role (muted) + a status dot (idle/ready/busy/error
  color); grid = repeat(auto-fill, minmax(280px,1fr)), gap 16px; hover = lift + accent glow; min-height ~180px.
- TEAM / OVERVIEW: a "constellation" — the HUB (NEXUS) featured/centered, specialists in the grid
  below; an ACTIVITY FEED panel alongside (recent events list).
- BADGES: pills (radius ~20px, 11px, 600, UPPERCASE, letter-spacing).
- MODALS: centered, max-width ~480px, radius-lg, shadow-lg, a slide-up + slight-scale entrance, dim backdrop.
- "ADD" CARD: a dashed-border tile with a centered + and label (e.g. "New agent") for create actions.

## 6. Tweaks panel (live customization — floating, bottom-right, ~280px, dismissible)
Sections: THEME (the 5 above), DENSITY (comfortable | compact — compact trims card/nav/grid padding
+ gaps), GLOW (slider 0..1), ACCENT (color swatches that set --ac). All choices PERSISTED per user
(localStorage) and APPLIED BEFORE FIRST PAINT (no flash-of-unstyled). The footer gear opens it.

## 7. Constraints
- Original CSS authored from this spec; design tokens; one token set re-skins everything.
- Theme/density/glow/accent: runtime, no reload, persisted, pre-paint applied.
- Respect prefers-reduced-motion; aim for readable contrast in every theme.
- Load the named web fonts (self-host or a font CDN); provide system fallbacks as listed.
- Verify with a headless browser (Playwright): screenshot the overview in obsidian + stark + forge +
  light, toggle density + glow, and confirm no flash-of-unstyled on reload. Save the screenshots.
