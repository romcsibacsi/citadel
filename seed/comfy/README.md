# Studio ↔ local ComfyUI — interop spec (operator's own data)

This folder describes how the operator's Studio drives **their local ComfyUI** GPU server to actually
render images and videos — "ugyanúgy, mint a régi rendszerben". These are **data assets / an external-
service contract** (ComfyUI's API-format node graphs — exactly what ComfyUI's *Save (API Format)* emits),
not orchestration code. Build your own implementation from this spec.

The three graph files here are the literal request bodies the local ComfyUI expects:
- `image-sdxl.api.json` — text→image (SD/SDXL).
- `video-wan22-14b.api.json` — text/image→video, **the default** (Wan 2.2 A14B MoE).
- `video-wan22-5b.api.json` — smaller/faster fallback (Wan 2.2 TI2V-5B).

---

## 1. The whole pipeline (one generation)

```
UI request (mode + prompt + settings)
  → take single-GPU lock synchronously (one job at a time; 2nd → 409)
  → start async job, return jobId immediately; UI polls job status
  → ensureComfyUp()         (if ComfyUI down + SSH configured → wake it, poll until /system_stats answers)
  → freeOllamaVram()        (evict any loaded local LLM so brain + gen model don't OOM the GPU)
  → [optional brain] local model expands the short/HU prompt → detailed EN prompt + picks the tool
  → build the ComfyUI API graph for the chosen tool, clamp params, inject prompt/seed/size/etc.
  → POST /prompt {prompt: <graph>, client_id}  → prompt_id
  → poll GET /history/{prompt_id} until outputs appear or status=error or deadline
  → GET /view?filename&subfolder&type  → bytes
  → save into the Studio output dir (→ shows up in the Files view)
  → (video) ffmpeg motion-interpolate to 30fps, ffprobe the FINAL file for honest metadata
  → release GPU lock (in finally — covers errors/timeouts too)
```

Generation uses the **local GPU only** — never the chat LLM, never an API key.

---

## 2. ComfyUI HTTP API (the only endpoints used)

Base URL is **config/vault-driven** (the operator sets it; e.g. `http://comfyui-host:8188`). Read it at
runtime so a change takes effect without a restart. Strip trailing slashes. Put a per-request timeout
(~60s) on every call so a hung-but-accepted socket can't block forever (a real failure mode on this box).

| Call | Purpose |
|---|---|
| `GET /system_stats` | reachability + device info (status probe / wake poll) |
| `GET /object_info/CheckpointLoaderSimple` | list available checkpoints — names at `CheckpointLoaderSimple.input.required.ckpt_name[0]` |
| `POST /prompt` | body `{ "prompt": <api-graph>, "client_id": "<random>" }` → `{ "prompt_id": "..." }` |
| `GET /history/{prompt_id}` | poll for completion; outputs at `hist[prompt_id].outputs[nodeId].{images|gifs|videos}[]` (`{filename, subfolder, type}`); error at `.status.status_str === "error"`; done at `.status.completed === true` |
| `GET /view?filename=&subfolder=&type=` | download a produced file as bytes |
| `POST /upload/image` (multipart `image` + `overwrite=true`) | upload a local image for image→video; returns `{name, subfolder}` → reference as `subfolder/name` (or just `name`) from a `LoadImage` node |

Poll cadence: images ~1.5s interval / ~180s deadline; video ~2s interval / **~30 min** deadline (a 14B
accurate clip or a thermally-throttled card can legitimately run minutes; the per-poll socket timeout
still bounds a genuinely hung host).

---

## 3. IMAGE — `image-sdxl.api.json`

Standard 7-node txt2img graph (CheckpointLoaderSimple → EmptyLatentImage → 2×CLIPTextEncode → KSampler
→ VAEDecode → SaveImage).

**Param defaults / clamps** (UI settings override the model's suggestion):

| param | default | clamp |
|---|---|---|
| width / height | 1024 | 256–2048 |
| steps | 28 | 1–80 |
| cfg | 6 | 1–20 |
| sampler / scheduler | `euler` / `normal` | — |
| batch | 1 | 1–4 |
| seed | random uint32 | 0–4_294_967_295 |

**Checkpoint resolution:** explicit param → `comfy_checkpoint` setting → first checkpoint the server
reports (`/object_info`). If the server has none, fail with a clear "install a model / set comfy_checkpoint".

`filename_prefix` → `studio/<ISO-timestamp>` (any prefix is fine; it just namespaces the output).
Save each produced image into the **generated-images** dir.

---

## 3a. CHARACTER-CONSISTENT IMAGE (InstantID) — `image-face-instantid.api.json`

`generate_image_with_face`: a reference face photo → the SAME identity rendered into the prompt's
scene/style. Read the `_comment`/`_defaults` keys in the JSON. Flow: upload the reference face via
`POST /upload/image` → put the returned name into the `LoadImage` node → submit the graph → poll → save
to the generated-images dir (prefix `studio/face-<timestamp>`).

**Params:** width/height 1016 (off-1024 avoids InstantID watermark artifacts), steps 30, **cfg 4.5
(LOW — InstantID requires it)**, `weight` = identity strength 0–1 (default 0.8, clamp). Same
checkpoint-resolution rule as §3. The reference image source is allow-listed to the generated-images /
generated-videos / uploads roots only.

**Dependency:** the ComfyUI box needs the **InstantID custom node** + its models (`ip-adapter.bin` in
`models/instantid`, `instantid_control.safetensors` in `models/controlnet`, an InsightFace antelopev2
model). If those aren't installed, the `/object_info` for `InstantIDModelLoader` is absent → surface a
clear "InstantID not installed on the ComfyUI server" message rather than a cryptic /prompt error.

---

## 4. VIDEO — Wan 2.2 (`video-wan22-14b.api.json` default, `…-5b.api.json` fallback)

The 14B is the operator's default (much better photoreal humans + motion than the 5B). Read the
`_comment` / `_variants` / `_models` keys inside each JSON — they carry the t2v↔i2v deltas, the fp8 vs
GGUF swap, the accurate-mode deltas, and exact model filenames.

**t2v vs i2v:** no source image → text→video (t2v). A source image → image→video (i2v): upload it via
`/upload/image`, add a `LoadImage` node, and (14B) route the samplers through `WanImageToVideo`'s
injected conditioning + latent. The same `generateVideo` path serves both `generate_video` (t2v) and
`animate_image` (i2v).

**Frame math (critical):** the Wan VAE temporal stride is 4, so latent length MUST be `4n+1`
(5, 9, … 117, 121). `seconds` (operator-requested duration) wins over `frames`:
`rawFrames = round(seconds * fps)`, then **snap**: `frames = clamp(round((rawFrames-1)/4)*4 + 1, 5, 121)`.
A non-conforming value is silently rounded DOWN by ComfyUI (e.g. 48→45) and the clip ends up shorter
than asked — snapping keeps the duration honest and the reported frame count matching the file.

**Defaults / clamps:**

| param | default | notes |
|---|---|---|
| width / height | 1280 × 704 | clamp 256–2048; accurate mode caps max side to ~960 (/16) |
| fps | 16 (14B) / 24 (5B) | native render fps |
| seconds | — | 1–60; **> one clip's cap (~7.5s @16fps) → chain clips, see §5** |
| frames | 49 | only if no `seconds`; 5–121 per clip |
| steps | Lightning: 4 (2–8) / accurate: (10–40) | requested steps ≤ 12 ⇒ Lightning; > 12 ⇒ accurate |
| cfg | Lightning: 1 / accurate: ~4.5 | Lightning LoRA is distilled for CFG=1, few steps |
| seed | random uint32 | — |
| boundary (MoE split) | `round(steps/2)` | clamped `[1, steps-1]` — high expert 0..boundary, low boundary..end |

**Always fold an anatomy guard into the video negative** (the model is prone to extra limbs / 3 legs),
then append the caller's negative:
`extra limbs, extra legs, extra arms, three legs, missing limbs, deformed, bad anatomy, mutated, fused fingers, extra fingers, distorted, low quality, blurry, watermark, text`

**SaveVideo** reports its file under `images` / `gifs` / `videos` depending on version — scan all three;
the last output is the muxed mp4. Save it into the **generated-videos** dir.

**Post-process (best-effort, never lose a render):** if native fps < 30, ffmpeg
`minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` to smooth playback (duration
preserved). Then `ffprobe` the FINAL file and report its ACTUAL width/height/fps/frames/duration — never
the requested values, because interpolation changes the frame count.

---

## 5. Long video = chained i2v clips

If requested `seconds` exceeds one clip's latent cap (~7.5s @16fps): render `ceil(total/maxClipSec)`
full-res clips. Clip 0 is t2v (or i2v from a supplied start image); each next clip is **i2v seeded with
the PREVIOUS clip's final frame** (ffmpeg `-sseof -0.5 … -update 1` grabs the last frame), so motion
continues across the cut instead of jumping. Concatenate all clips (re-encode to a common fps/size),
then delete the intermediates + scratch frames — only the final video remains. Report clip 0's origin
mode (t2v unless a start image was supplied), not the last chain clip's.

---

## 6. The Studio "brain" (optional but this is how the old one behaved)

The old Studio is a **thin local-model agent loop**, NOT Claude Code and NOT the chat LLM: it talks to a
local **ollama** model (`muse-brain:latest`, native `/api/chat` tool-calling) offering ONLY the media
tools, with a tiny focused system prompt. This is what makes a one-line Hungarian request
("csinálj egy 5mp-es videót egy rókáról") turn into a detailed English render. Behavior to preserve:

- **Always CALL a tool** (don't just talk, don't ask back needlessly).
- **Always expand** the (often short, Hungarian) request into a DETAILED ENGLISH prompt: subject +
  concrete action + **camera move** (slow zoom in, orbit, static, pan) + lighting + quality
  (photorealistic, sharp, detailed) + a good negative. For video, describe motion AND camera explicitly.
- If the user gives duration in **seconds**, set `seconds` (NOT `frames`).
- **Multi-step** ("make N images then a slideshow"): call the gen tool(s), then the edit/concat tool
  with the returned paths — one loop holds all tools, no multi-agent handoff.
- **Honest summary:** report ONLY facts from the tool RESULT (actual duration, frames, fps, resolution,
  seed) + the file path. Never echo the user's adjectives as fact (don't claim "5s"/"hyperreal" unless
  the result says so). If the requested length/size/quality wasn't met, say so plainly.
- One content rule: never anything involving minors.

**Mode restricts the toolset** so the model can't pick the wrong output type:
- **Kép / Image** → `generate_image`, `generate_image_with_face`.
- **Videó / Video** → `generate_video`, `animate_image`, `images_to_video`, `concat_videos`,
  `trim_video`, `extract_frame`.

**UI settings override the model's tool args** (a preset must be deterministic, not a suggestion the
small model might ignore): width, height, seconds, frames, steps, cfg, seed, negative.

**Runaway guards:** cap heavy gen tools at ~5 per request; cap loop rounds at ~10; per-chat-turn ollama
timeout ~180s (must cover a cold model reload after VRAM was freed).

Tool set (ollama function-style; gen tools call the graphs above):

| tool | maps to |
|---|---|
| `generate_image` | SDXL graph |
| `generate_image_with_face` | character-consistent (reference face → InstantID); separate face graph |
| `generate_video` | Wan t2v graph |
| `animate_image` | Wan i2v graph (start image) |
| `images_to_video` | ffmpeg slideshow (N s/image) |
| `concat_videos` | ffmpeg concat (≥2) |
| `trim_video` | ffmpeg trim (start, duration) |
| `extract_frame` | ffmpeg single frame → png |

> If wiring a local ollama brain is out of scope for now, the **minimum viable** Studio still satisfies
> the operator: a form (mode + prompt + settings) → build the graph directly → submit → poll → save →
> show in Files. The ollama brain is the prompt-expansion / multi-step layer on top — add it to reach
> full parity. Either way the rendering path (the graphs + the /prompt→/history→/view flow) is identical.

---

## 7. GPU wake + VRAM (so a cold box still works)

- **freeOllamaVram()** before every gen: `GET {ollama}/api/ps` → for each loaded model
  `POST /api/generate {model, keep_alive: 0}` to evict it. Best-effort; the 5090's 32GB is shared by the
  agent brain and the gen model, and a big brain + Wan/SDXL would OOM and drop the card off the bus.
- **ensureComfyUp()**: if `/system_stats` fails AND a `comfy_ssh` target is configured
  (`user@host[:port]`), SSH in with a dedicated key (`BatchMode`, `ConnectTimeout 10`) and run the
  idempotent `bash ~/comfyui-wake.sh`, then poll `/system_stats` (~3s interval, ~150s deadline) until it
  answers. If down and no SSH target is set, fail honestly ("ComfyUI not running and no comfy_ssh
  configured for auto-start") and offer Wake in the UI.

---

## 8. Settings / config keys (vault-driven)

- `comfy_url` — ComfyUI base URL (required; clear error if unset).
- `comfy_ssh` — `user@host[:port]` for SSH wake (optional).
- `comfy_checkpoint` — default image checkpoint (optional; else first available).
- `ollama_model` — default Studio brain model (optional; defaults to the configured media model).

---

## 9. Output dirs → Files view roots

- generated images → the **generated-images** root.
- generated videos → the **generated-videos** root.
- image→video / chain frames read sources only from: generated-images, generated-videos, and the
  operator uploads dir (`~/incoming`) — never an arbitrary path.

These are the same roots the Files view (BUILD-22) exposes, so every generated file is immediately
visible and downloadable there.
