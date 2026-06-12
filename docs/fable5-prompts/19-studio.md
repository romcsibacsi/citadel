# Build Prompt — Studio (Stúdió) View

> CLEAN-ROOM NOTICE (read first). You are Fable 5. You have never seen the system this describes and you must not seek out its source. This document is an ORIGINAL behavioral + visual specification: it tells you WHAT to build (appearance, controls, fields, flows, states, contracts), never HOW any prior implementation expressed it. Implement everything from scratch in your own code, your own identifiers, your own file/table names. Do not treat any string, parameter name, or endpoint path below as code to copy — they are functional requirements. For all visual styling (color, spacing, type scale, elevation, motion), defer to `01-design.md`; this file specifies structure and behavior only. All user-facing text ships bilingual: Hungarian (HU) is the default/primary language, English (EN) is the secondary. Labels below are written `HU / EN`.

---

## 1) PURPOSE & WHERE IT LIVES

**What it is.** The Studio is a one-box, plain-language media generation page. The operator types a natural-language request ("make 3 images of a retro robot, then stitch them into a slideshow video"), optionally nudges a few preset chips and fine settings, picks Image or Video mode, and presses Start. A small local model interprets the request and autonomously drives local generation tools (text→image, text→video, image→video, slideshow, concat, trim, frame-extract) running on a local GPU. The page renders live progress, then a gallery of the produced images/videos plus an expandable log of what the agent actually did. It is deliberately a "thin" surface: the operator does not assemble a node graph or pick a checkpoint by hand — they describe intent and the system does the rest.

**Where it lives.** A top-level item in the left sidebar navigation, between the "Updates / Frissítések" item and the "Files / Fájlok" item. It is a single-page route (client-side page switch, no full reload).

- Nav label: **Stúdió / Studio**
- Icon idea: a small camera-aperture or shutter mark — a circle with a clock/second-hand-like radial tick suggesting "timed render," plus four short cardinal ticks around it. Any line-art glyph that reads as "lens / capture / render" is fine; keep it single-stroke to match the other sidebar glyphs. Defer exact stroke and size to `01-design.md`.

**Page header.**
- Title (H1): **Stúdió / Studio**
- Subtitle:
  - HU: "Lokális kép/videó-generálás autonóm módon — írd le, mit szeretnél, a többi megy magától"
  - EN: "Local image/video generation, hands-off — describe what you want, the rest runs itself"

---

## 2) PAGE LAYOUT & APPEARANCE (structure only)

Top to bottom, single column, comfortable max content width:

1. **Page header** — title + subtitle (above).
2. **Composer block** — the main interactive panel. Contains, in order:
   a. **Mode toggle** (Image / Video segmented control).
   b. **Request textarea** (the big prompt box).
   c. **Preset bar** — several labeled groups of small toggle "chips": Style, Motion (video-only), Size/aspect, Quality, Length (video-only). The Length group also contains a small custom-seconds number input.
   d. **Run row** — a "Settings" secondary button (gear) on the left and a primary "Start" button on the right.
3. **Fine-settings modal** (hidden until opened from the Settings button) — overlay dialog with a small grid of numeric fields + a negative-prompt textarea.
4. **Status line** (hidden until a run begins) — a single live text line showing progress/elapsed/result-summary/error.
5. **Results gallery** — a flowing grid of produced image thumbnails and inline video players (empty until a run finishes).
6. **Details / log** — a collapsible disclosure ("Details — what the agent did"), collapsed by default, containing one line per tool step.

There is no separate "history" list on this page; finished jobs are not persisted as a browsable list here (produced files live on the Files page — see §6). Defer all spacing, chip styling, grid gutters, and the modal's look to `01-design.md`.

---

## 3) CONTROLS — every interactive element

### 3.1 Mode toggle (segmented, two buttons, exactly one active)
- **🖼 Kép / 🖼 Image** — default active. Sets mode = image.
- **🎬 Videó / 🎬 Video** — sets mode = video.
- Effect of switching:
  - Restricts which generation tools the backend will offer the model (image mode → still-image tools only; video mode → video tools only), so the model cannot accidentally produce the wrong output type. Mode is sent with the run request.
  - Shows/hides the **video-only** preset groups (Motion and Length): visible only in Video mode, hidden in Image mode so the image flow isn't cluttered.
  - Re-derives the effective "steps" value from the currently selected Quality level, because the step counts differ between image and video (see §6.4). Re-highlights chips to match.

### 3.2 Request textarea (the prompt box)
- Multi-line, ~3 rows, auto-expandable is optional.
- Placeholder:
  - HU: "Pl.: Csinálj 3 képet egy retró robotról különböző pózokban, majd fűzd őket egy diavetítés-videóba."
  - EN: "E.g.: Make 3 images of a retro robot in different poses, then stitch them into a slideshow video."
- Keyboard: **Ctrl/Cmd+Enter** submits the run (same as pressing Start). Plain Enter inserts a newline.
- The textarea is the single source of truth for the prompt text. Style and Motion chips (below) inject/remove phrases directly INTO this textarea (so the operator can see and hand-edit them).

### 3.3 Style chips (group label: **Stílus / Style**)
A row of toggle buttons. Each chip, when toggled on, appends a descriptive English style phrase to the request textarea (comma-separated); toggling off removes that exact phrase again. Multiple may be active at once. A chip shows "active" highlight when its phrase is currently present in the textarea (kept in sync even if the operator edits the box by hand). Chips and the English phrase each injects:

| Chip label (HU / EN) | Injected phrase (English, into prompt) |
|---|---|
| Fotorealisztikus / Photorealistic | photorealistic, sharp focus, natural lighting, 85mm |
| Hiperrealisztikus / Hyperrealistic | hyperrealistic, extreme detail, ultra sharp, photorealistic, 8k |
| Filmes / Cinematic | cinematic mood, high contrast, dramatic lighting, film grain |
| Anime / Anime | anime style, vivid colors, clean lines, cel shading |
| Cartoon / Cartoon | cartoon style, bold outlines, flat vivid colors |
| Pixar / Pixar | Pixar-style 3D animation, stylized character, soft lighting |
| Képregény / Comic | comic book style, ink outlines, halftone shading |
| Festmény / Painting | digital painting, visible brushstrokes, artistic |
| Akvarell / Watercolor | watercolor painting, soft washes, paper texture |
| 3D render / 3D render | 3D render, detailed, octane render |
| Koncept-art / Concept art | concept art, digital illustration, atmospheric, detailed |
| Retró / Retro | retro, vintage, 70s color palette |
| Noir / Noir | black and white, film noir, strong shadows |

These are TEXT injections only — they do not set structured parameters.

### 3.4 Motion chips — VIDEO ONLY (group label: **Mozgás (videó) / Motion (video)**)
Same toggle-into-textarea behavior as Style chips, but the injected phrases are camera/motion descriptions (these may be injected in Hungarian; the backend model is instructed to translate/expand to English at tool-call time). Hidden in Image mode.

| Chip label (HU / EN) | Injected motion phrase |
|---|---|
| Ráközelítés / Zoom in | slow camera zoom-in toward the subject |
| Kihúzás / Zoom out | camera slowly pulls back / recedes |
| Követő snitt / Tracking shot | tracking camera move following the subject |
| Körbe / Orbit | orbiting camera move around the subject |
| Panoráma / Pan | slow side pan with the camera |
| Statikus / Static | static camera, only the subject moves |
| Kézikamera / Handheld | slight handheld camera shake, documentary feel |

### 3.5 Size / aspect chips (group label: **Méret / arány — Size / aspect**)
These are STRUCTURED settings, not text. Each chip sets a fixed width×height pair as a hard override (clearing it if the same chip is toggled again). At most one active at a time within the group.

| Chip label (HU / EN) | Width×Height |
|---|---|
| Négyzet 1:1 / Square 1:1 | 1024 × 1024 |
| Álló 2:3 / Portrait 2:3 | 832 × 1216 |
| Fekvő 3:2 / Landscape 3:2 | 1216 × 832 |
| Videó 16:9 / Video 16:9 | 1280 × 720 |
| Videó 9:16 / Video 9:16 | 720 × 1280 |

### 3.6 Quality chips (group label: **Minőség / Quality**)
A LEVEL selector (one active at a time, togglable to none). The level maps to a concrete "steps" number, and the mapping DEPENDS ON MODE (see §6.4). Selecting a level sets the steps override; toggling it off (or selecting none) clears the steps override (auto).

| Chip label (HU / EN) | Level | Note |
|---|---|---|
| Gyors / Fast | fast | fewest steps |
| Normál / Normal | normal | |
| Magas / High | high | |
| Pontos / Accurate | accurate | tooltip (HU): "Videónál: Lightning nélkül, több step → jobb prompt-/kamera-követés + anatómia (lassabb)" / (EN) "Video: no Lightning, more steps → better prompt/camera adherence + anatomy (slower)" |

### 3.7 Length chips + custom seconds — VIDEO ONLY (group label: **Hossz (videó) / Length (video)**)
Structured seconds setting. Hidden in Image mode.
- Preset chips: **2 mp / 2 s**, **3 mp / 3 s**, **5 mp / 5 s** (one active at a time, togglable to none). Selecting a chip sets seconds and clears the custom-seconds input.
- **Custom seconds** number input:
  - Placeholder: "egyéni mp / custom s"
  - Range/step: min 1, max 60, step 0.5
  - Tooltip (HU): "Egyéni videóhossz másodpercben (max 60 — 7,5 mp fölött a rendszer i2v-láncolt klipekből fűzi össze)" / (EN): "Custom video length in seconds (max 60 — above ~7.5s the system stitches it from i2v-chained clips)."
  - Typing a valid positive number sets seconds (overriding the chips); clearing it unsets seconds. When custom is in use, none of the 2/3/5 chips show active.

### 3.8 Run row
- **⚙ Beállítások / ⚙ Settings** (secondary button) — opens the fine-settings modal (§5.1). Tooltip (HU): "Finom beállítások (felülírja a preseteket)" / (EN): "Fine settings (override the presets)."
- **Indítás / Start** (primary button) — submits the run (§6.1). Disabled while a run is in flight.

---

## 4) LISTS / CARDS / TABLES

This page has no data tables and no persistent list. The only collection rendered is the **results gallery** plus the **tool log**, both populated when a job finishes.

### 4.1 Results gallery items
A flowing grid of result tiles, one per produced file, in production order:
- **Image tile** — a thumbnail of the produced image (lazy-loaded). Cursor indicates it is zoomable. Clicking it opens the shared media lightbox (§5.2) for that image.
- **Video tile** — an inline video player with native controls, set to loop, autoplay off. Plays in place.

Each tile shows only the media itself (no caption, size, or per-tile menu on this page). There are no per-item action menus in the gallery — the operator clicks an image to open the lightbox (which offers download), and uses the inline player controls for video. "Save/reuse" of results happens via the Files page where these same files appear (see §6.6).

### 4.2 Tool log lines (inside the Details disclosure)
One plain-text line per step the agent performed, in order. Two kinds:
- **Tool step** — a one-line factual summary returned by each tool call (e.g. "Image ready: <path> — 1024×1024, 30 steps, seed 12345"; "Video ready: <path> — 49 frames @ 16fps ≈ 3s, 1280×720, 8 steps, <mode>, seed …"; "Slideshow ready: <path>"; "Concatenated: <path>"; "Trimmed: <path>"; "Frame saved: <path>"; or an error line "ERROR (<tool>): <message>"). These report the ACTUAL rendered facts, not the requested values.
- **Assistant step** — the model's final free-text summary, if any.

The log is text only (no thumbnails, no actions). Its only control is the disclosure summary that expands/collapses it: **Részletek (mit csinált az ügynök) / Details (what the agent did)**, collapsed by default.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

### 5.1 Fine-settings modal — **Finom beállítások / Fine settings**
A centered overlay dialog opened by the ⚙ Settings button. It pre-fills its fields from the currently held structured settings each time it opens (so it reflects what the chips have set), and an empty field always means "auto / unset."

- **Heading:** "Finom beállítások / Fine settings"
- **Sub-note:** HU "Ezek FELÜLÍRJÁK a preset-chipeket és a modell saját értékeit. Üres mező = automatikus." / EN "These OVERRIDE the preset chips and the model's own values. Empty field = automatic."
- **Field grid** (numeric inputs, each labeled; placeholder shown in brackets):
  1. **Szélesség (px) / Width (px)** — number, min 256, max 2048, step 8, placeholder "auto".
  2. **Magasság (px) / Height (px)** — number, min 256, max 2048, step 8, placeholder "auto".
  3. **Minőség (steps) / Quality (steps)** — number, min 1, max 80, placeholder "auto". Typing a value here clears the Quality LEVEL chip selection (a manual steps number overrides the level).
  4. **CFG (prompt-követés) / CFG (prompt adherence)** — number, min 1, max 20, step 0.5, placeholder "auto".
  5. **Hossz (mp, videó) / Length (s, video)** — number, min 1, max 60, step 0.5, placeholder "auto".
  6. **Seed (üres = véletlen) / Seed (empty = random)** — number, min 0, placeholder "random".
- **Full-width field:**
  7. **Negatív prompt (amit NE tartalmazzon) / Negative prompt (what to EXCLUDE)** — textarea (~2 rows), placeholder HU "pl. elmosódott, torz kéz, szöveg" / EN "e.g. blurry, distorted hands, text".
- **Action row (3 buttons):**
  - **Mind törlése / Clear all** (secondary) — wipes ALL structured settings (every numeric field + negative + the Quality level + custom seconds), then closes. This resets the page back to fully-automatic; the next run uses model/system defaults.
  - **Bezárás / Close** (secondary) — closes without applying any edits made in the modal.
  - **Alkalmaz / Apply** (primary) — reads each field; an empty/NaN field unsets that setting, a valid number sets it as a hard override; sets the negative prompt if non-empty (else clears it); then re-syncs the chip highlights and closes.
- **Dismiss:** clicking the dark backdrop outside the dialog closes it (same as Close).

Note on precedence (state the contract): structured settings set here OR by the chips OVERRIDE whatever the model chooses at tool-call time. So the operator's size/steps/cfg/seconds/seed/negative always win over the model's guess.

### 5.2 Media lightbox (shared component, opened from an image result tile)
Clicking an image result opens the app's shared media lightbox overlay:
- Large preview of the image.
- The file's name displayed.
- A **Download / Letöltés** action (link) that downloads the original file.
- Standard close (backdrop / close affordance).
This is the same lightbox the Files page uses; it is the page's "use the result" path for stills. Video results are previewed/scrubbed in their inline player; to download a video the operator opens it on the Files page.

---

## 6) FLOWS & BEHAVIOR (behavior/contract, not code)

### 6.1 Start a generation
1. Operator fills the request box (and optionally chips/settings/mode) and presses **Start** (or Ctrl/Cmd+Enter).
2. If the request text (trimmed) is empty, do nothing.
3. Disable the Start button; show the status line with text "Indítás… / Starting…"; clear any previous results gallery and log.
4. POST a "start run" request to the studio run API with: the request text, the structured `settings` object (only the keys that are set — width/height/seconds/frames/steps/cfg/seed/negative), and the `mode` ("image" or "video").
5. The backend does NOT render synchronously. It validates, takes a single-GPU lock, and immediately returns a **job id** (a short opaque token) + an initial status of "running." The page stores this job id (so a refresh can re-attach — see §6.3) and begins polling.
6. If the start call fails or returns an error (including the busy/409 case, §6.7), show the error in the status line and re-enable Start (do not start polling).

**Why async:** a long render (e.g. a 60-second / multi-clip video) can take many minutes; a synchronous HTTP request would hit a reverse-proxy or browser read-timeout and look like a network failure even though the GPU is still working. The submit→poll→result pattern avoids that.

### 6.2 Poll to completion (the running state)
While polling, repeatedly query the job-status API by job id (about every 2.5 seconds):
- **status = running:** update the status line to "Dolgozom… <progress> (<elapsed>s) / Working… <progress> (<elapsed>s)". The progress string is a short human phrase the backend sets as it advances (e.g. "the model is planning…", the current tool name, a percent during the render). Elapsed seconds come from the server (so a re-attached job shows true elapsed time, not time-since-reattach).
- **status = done:** set the status line to the model's final reply text (or "Kész. / Done." if none), then render the results gallery + log from the response (§6.4 below describes the response shape). Stop polling, clear the stored job id, re-enable Start.
- **status = error:** set the status line to "Hiba: <message> / Error: <message>", stop polling, clear the stored id, re-enable Start.
- **Wall-clock cap:** if a job stays "running" longer than ~45 minutes, stop polling and show a message that it ran too long and may still be finishing in the background — check the Files page. (This keeps a hung GPU from spinning the UI forever with Start disabled.)
- **Transient poll failures:** a dropped/5xx/proxy-error poll is tolerated as a "miss," not a fatal error — keep retrying for a bounded number of consecutive misses (~40). On exceeding that, show "A kapcsolat megszakadt — a generálás a háttérben folytatódhat, nézd meg a Fájlok oldalt. / Connection lost — generation may continue in the background, check the Files page." Reset the miss counter only on a genuinely parsed, usable response.
- **404 (unknown/expired job):** show "A háttérfolyamat megszakadt vagy a szerver újraindult — nézd meg a Fájlok oldalt. / The background job was lost or the server restarted — check the Files page," and stop. (Jobs are in-memory; a server restart or the ~1-hour job TTL can drop the record.)

### 6.3 Resume after page refresh
On Studio page load, if a job id was stored from a prior run, query that job once:
- If it is still "running," silently re-attach and resume the polling/rendering UI as in §6.2.
- Otherwise (finished, errored, unknown), discard the stored id and show the page fresh.

### 6.4 Result rendering (the done payload)
The done response carries: a `reply` (the model's text summary), a `files` array (absolute produced-file paths), and a `log` array (ordered step lines). For each file in `files`:
- Map the path to a servable URL. Only files under the two generated-media roots are renderable: the still-image output root ("comfy/Képek") and the video output root ("comfy-video/Videók"). A path outside these is skipped.
- If the extension is an image type (png/jpg/jpeg/webp/gif) → add a clickable thumbnail tile (lightbox on click).
- If the extension is a video type (mp4/webm) → add an inline looping video player tile.
Then append each `log` line as a text row in the Details disclosure.

**Quality-level → steps mapping (mode-dependent), applied client-side before submit:**
- Image mode: fast = 20, normal = 30, high = 45, accurate = 60.
- Video mode: fast = 4, normal = 6, high = 8, accurate = 20. (The video model runs a fast/"Lightning" path at very few steps for fast/normal/high; "Accurate" deliberately uses more steps without the fast path for better adherence/anatomy at the cost of speed.)
When the operator switches mode, re-derive the steps override from the still-selected Quality level using the new mode's table.

### 6.5 What the backend agent does (contract, concept-level)
The run API hands the request + settings + mode to a small local model running a focused agent loop with ONLY media tools available. The model is instructed to: always actually CALL a tool (not just talk), expand the (often short, Hungarian) request into a DETAILED ENGLISH prompt (subject + concrete action + camera move + lighting + quality + a good negative), use seconds when the user asked in seconds, chain tools for multi-step jobs (generate first, then edit/stitch with the produced paths), and report ONLY the tool's actual returned facts in its summary (never invent length/size/quality, never echo the user's adjectives as fact). The operator's structured `settings` are applied as HARD overrides on top of whatever the model passes to each tool. There is a hard cap on the number of heavy generations per single request and a bounded number of tool rounds, so a looping model cannot queue endless renders.

Available tools the model may chain (the operator never picks these directly): text→image; character-consistent image from a reference face; text→video (describe motion/camera); image→video (animate an existing image); images→slideshow video; concat videos; trim a clip; extract a frame as an image. Mode gates which subset is offered (image mode = the two image tools; video mode = the video/edit tools).

### 6.6 Use / download results
- **Image:** click the result thumbnail → lightbox → Download. (Or find the same file on the Files page under "Képek / Images.")
- **Video:** play inline; to download, open the Files page under "Videók / Videos." All produced files are also browsable, sortable, and downloadable there.

### 6.7 One-job-at-a-time GPU lock (409)
The GPU serializes work, so only ONE studio generation may run at a time across the whole system (a UI run AND an agent-initiated generation share the same lock). If a run is started while another generation is already in flight, the start API rejects it up front with a **409 Conflict** and a clear message rather than letting it fail mid-render:
- HU: "Már fut egy generálás — várd meg, amíg befejeződik." / EN: "A generation is already running — wait until it finishes."
The page shows this message in the status line and re-enables Start.

### 6.8 Parameter validation / clamping (contract)
The start API coerces and clamps the incoming settings to safe ranges; anything non-numeric or out of range is dropped (falls back to the model's arg or the generation default) so a malformed or abusive payload cannot push an enormous render at the GPU. The enforced bounds:
- width: 256–2048 (rounded to integer)
- height: 256–2048 (rounded)
- seconds: 1–60
- frames: 5–241 (rounded)
- steps: 1–80 (rounded)
- cfg: 1–20
- seed: 0–4,294,967,295 (rounded)
- negative: trimmed string, capped at ~2000 characters
The empty request is rejected with 400 ("A request mező kötelező. / The request field is required."). The client-side modal inputs advertise matching min/max/step, but the server is the authority — re-clamp on the server regardless of what the client sends.

### 6.9 Destructive-action confirmations
There are no destructive actions on this page. **Clear all** in the settings modal only resets local input state (it produces nothing and deletes no files) and so needs no confirmation. Starting a run is non-destructive (it only adds new files). No delete/overwrite happens from this view.

### 6.10 ComfyUI backend reachability (related indicator)
Image generation runs on a local ComfyUI backend that may be asleep/off. There is a small live status indicator (a colored dot + a text line + an optional "Wake / Ébresztés" button) that surfaces whether the image backend is configured, reachable, its version/device, and how many models it sees. In this system that indicator currently lives on a different settings/vault page, but it is part of the same generation contract, so implement it (placement is your call per `01-design.md`; the Studio page is a reasonable home):
- A status probe returns one of: **not configured** (no backend URL set) → dot off, text "ComfyUI: nincs beállítva (add meg a comfy_url-t) / ComfyUI: not configured (set the backend URL)"; **reachable** → dot on, text "ComfyUI: FUT / RUNNING" with optional version, device name, and model count ("· N modell / · N models"); **unreachable** → dot off, text "ComfyUI: leállítva / stopped"; **unknown/probe failed** → dot off, "ComfyUI: ismeretlen / unknown".
- A **Wake / Ébresztés** button (shown only if a wake mechanism is configured) triggers a remote wake of the backend, then re-probes status a handful of times over the next ~1–2 minutes until it comes up. While waking, show "ComfyUI: ébresztés… / ComfyUI: waking…".
- Light polling: refresh this status roughly every 20 seconds while its page is open.

---

## 7) STATES

- **Empty (initial):** composer ready, mode = Image, no chips active, no structured settings, status line hidden, results gallery empty, Details disclosure collapsed and empty. No "empty state" illustration is required beyond the empty gallery.
- **Submitting:** Start disabled, status line visible showing "Indítás… / Starting…", gallery + log cleared.
- **Running:** Start disabled, status line shows "Dolgozom… <progress> (<elapsed>s)", updated each poll. Live-updating; no spinner is strictly required but the elapsed counter conveys liveness. Defer any progress animation to `01-design.md`.
- **Done:** status line shows the model's summary text; gallery shows the produced media; log shows the steps; Start re-enabled.
- **Error:** status line shows "Hiba: <message>"; Start re-enabled; gallery/log show whatever (if anything) was produced.
- **Busy / 409:** status line shows the "already running" message; Start re-enabled; nothing submitted.
- **Connection-lost / timeout / 404:** status line shows the appropriate "check the Files page" message; Start re-enabled; polling stops. The render may still finish server-side and land in the file roots.
- **Backend asleep/unconfigured:** the ComfyUI indicator (if placed here) reflects it; a run attempted against an unreachable backend will surface as an error result with an actionable message (e.g. backend/model not reachable), not a silent hang.
- **Permission-denied:** see §8 — agent identities do not get this page; if reached without authorization, the API calls fail the standard bearer-auth gate and the page should treat that as an error state.

**Live-update / poll behavior summary:** poll job status ~every 2.5s; tolerate ~40 consecutive transient misses; hard wall-clock cap ~45 min; persist the job id so a refresh re-attaches; clear the id on any terminal state. The ComfyUI indicator self-polls ~every 20s.

---

## 8) PERMISSIONS / VISIBILITY (operator vs agent; autonomy gating)

- This is an **operator-facing dashboard page**. The human operator is the intended (single) user.
- All run/poll/status/wake API calls sit behind the dashboard's standard bearer-token auth (every API route is gated). The page assumes an authenticated operator session.
- **Agents do not use this page.** Background agents can themselves trigger media generation through the same backend tools (and they share the same single-GPU lock — that is the cross-cutting reason a UI run can get a 409 while an agent is rendering), but they do so programmatically, not through this UI.
- **Autonomy gating:** the page itself is a manual, operator-driven surface; pressing Start is an explicit human action, so no autonomy-level threshold gates the page. The gating that matters here is the shared GPU lock (one job at a time) and the per-request generation cap, both enforced server-side regardless of who initiates. There is no per-role hiding/disabling of controls within this page beyond the auth gate.

---

## 9) DATA CONCEPTS read/written (concept-level)

- **Run request (written, transient):** the prompt text, the chosen mode, and the structured settings (width, height, seconds, frames, steps, cfg, seed, negative). Sent to the run API; not persisted as an editable record.
- **Job (server-side, in-memory, ephemeral):** id, status (running/done/error), a human progress string, started/finished timestamps, and on completion the result (reply text + produced file paths + step log) or an error message. Jobs are NOT durable — a server restart loses the record; finished jobs are pruned after ~1 hour. The client persists only the active job id (in browser-local storage) for refresh re-attach.
- **Structured settings (client-held UI state):** the currently selected size/quality-level/seconds/custom-seconds and the modal's numeric overrides + negative prompt. Lives in page state; reset by "Clear all."
- **Produced media files (written, durable):** images land in the still-image output root; videos land in the video output root. These are real files browsable on the Files page; they are the lasting artifact of a run.
- **ComfyUI backend status (read-only):** configured flag, reachability, version, device name, model/checkpoint count, and a wake-capability flag — read from the backend status probe; never written by this page (except triggering a wake action).
- **Local model selection (read):** the run uses a configured local model name by default; the page does not expose model selection as a control here (it relies on the system-configured model). Treat model id as a system setting, not a Studio-page field.

---

## 10) i18n — every string ships HU (default) + EN

Implement a translation table; HU is the default and EN the alternate. Strings to include (grouped):

**Nav & header:** Stúdió / Studio; subtitle "Lokális kép/videó-generálás autonóm módon — írd le, mit szeretnél, a többi megy magától" / "Local image/video generation, hands-off — describe what you want, the rest runs itself".

**Mode:** 🖼 Kép / 🖼 Image; 🎬 Videó / 🎬 Video.

**Request placeholder:** "Pl.: Csinálj 3 képet egy retró robotról különböző pózokban, majd fűzd őket egy diavetítés-videóba." / "E.g.: Make 3 images of a retro robot in different poses, then stitch them into a slideshow video."

**Group labels:** Stílus / Style; Mozgás (videó) / Motion (video); Méret / arány — Size / aspect; Minőség / Quality; Hossz (videó) / Length (video).

**Style chip labels:** Fotorealisztikus/Photorealistic; Hiperrealisztikus/Hyperrealistic; Filmes/Cinematic; Anime/Anime; Cartoon/Cartoon; Pixar/Pixar; Képregény/Comic; Festmény/Painting; Akvarell/Watercolor; 3D render/3D render; Koncept-art/Concept art; Retró/Retro; Noir/Noir.

**Motion chip labels:** Ráközelítés/Zoom in; Kihúzás/Zoom out; Követő snitt/Tracking shot; Körbe/Orbit; Panoráma/Pan; Statikus/Static; Kézikamera/Handheld.

**Size chip labels:** Négyzet 1:1/Square 1:1; Álló 2:3/Portrait 2:3; Fekvő 3:2/Landscape 3:2; Videó 16:9/Video 16:9; Videó 9:16/Video 9:16.

**Quality chip labels:** Gyors/Fast; Normál/Normal; Magas/High; Pontos/Accurate (+ tooltip pair in §3.6).

**Length:** 2 mp/2 s; 3 mp/3 s; 5 mp/5 s; custom placeholder "egyéni mp"/"custom s" (+ tooltip pair in §3.7).

**Run row:** ⚙ Beállítások / ⚙ Settings (+ tooltip "Finom beállítások (felülírja a preseteket)" / "Fine settings (override the presets)"); Indítás / Start.

**Settings modal:** heading "Finom beállítások"/"Fine settings"; note "Ezek FELÜLÍRJÁK a preset-chipeket és a modell saját értékeit. Üres mező = automatikus." / "These OVERRIDE the preset chips and the model's own values. Empty field = automatic."; field labels Szélesség (px)/Width (px), Magasság (px)/Height (px), Minőség (steps)/Quality (steps), CFG (prompt-követés)/CFG (prompt adherence), Hossz (mp, videó)/Length (s, video), Seed (üres = véletlen)/Seed (empty = random), Negatív prompt (amit NE tartalmazzon)/Negative prompt (what to EXCLUDE); placeholders "auto", "random", and negative "pl. elmosódott, torz kéz, szöveg"/"e.g. blurry, distorted hands, text"; buttons Mind törlése/Clear all, Bezárás/Close, Alkalmaz/Apply.

**Status/progress:** Indítás…/Starting…; "Dolgozom… {progress} ({secs}s)"/"Working… {progress} ({secs}s)"; Kész./Done.; "Hiba: {msg}"/"Error: {msg}".

**Errors/edge messages:** "Már fut egy generálás — várd meg, amíg befejeződik." / "A generation is already running — wait until it finishes."; "A request mező kötelező." / "The request field is required."; "Hiba a Stúdió-kérés indításakor (hálózat?)." / "Error starting the Studio request (network?)."; "A háttérfolyamat megszakadt vagy a szerver újraindult — nézd meg a Fájlok oldalt." / "The background job was lost or the server restarted — check the Files page."; "A kapcsolat megszakadt — a generálás a háttérben folytatódhat, nézd meg a Fájlok oldalt." / "Connection lost — generation may continue in the background, check the Files page."; "Túl sokáig fut — a generálás a háttérben folytatódhat, nézd meg a Fájlok oldalt." / "Running too long — generation may continue in the background, check the Files page."

**Details disclosure:** "Részletek (mit csinált az ügynök)" / "Details (what the agent did)".

**ComfyUI indicator:** "ComfyUI: …" (loading); "ComfyUI: nincs beállítva (add meg a comfy_url-t)" / "ComfyUI: not configured (set the backend URL)"; "ComfyUI: FUT" / "ComfyUI: RUNNING" (+ optional " ({version}) · {device} · {N} modell" / " ({version}) · {device} · {N} models"); "ComfyUI: leállítva" / "ComfyUI: stopped"; "ComfyUI: ismeretlen" / "ComfyUI: unknown"; "ComfyUI: ébresztés…" / "ComfyUI: waking…"; button Ébresztés / Wake.

---

### Implementation notes for Fable 5
- Build the composer as the only required surface; the results gallery and log are derived entirely from the job-done payload.
- Keep the submit→poll→result contract exactly: a synchronous render would time out on long video jobs — do NOT block the HTTP request on the render.
- Enforce the GPU single-job lock and the parameter clamps SERVER-SIDE; the client min/max are conveniences only.
- Persist the active job id client-side so a refresh re-attaches; clear it on every terminal state.
- All look-and-feel (chip pills, segmented toggle, modal chrome, gallery grid, status styling, dot colors) defers to `01-design.md`.
