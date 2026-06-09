# ARGUS — videó-megfigyelő ügynök

ARGUS a CITADEL csapat **videó-megfigyelője**: külső videókat (elsősorban YouTube) néz meg és foglal
össze — nem csak az átirat, hanem a **képkockák** alapján is, a saját vision-jével olvasva. On-demand
dolgozik: NEXUS (vagy az operátor) átad egy URL-t, ARGUS visszaad egy átirat+kép alapú összefoglalót.

## Elhatárolás a csapaton belül

| Ügynök | Hatókör |
|---|---|
| **ARGUS** | KÜLSŐ, kész videó (YouTube) megnézése + összefoglalása (átirat + kockák) |
| **SCREENER** | A SAJÁT draft-videóink vágása/elemzése (ffmpeg) |
| **REEL / CREATIVE** | Új videó / kép generálása helyi GPU-n (Wan / ComfyUI) |

## Konfiguráció

- Seed: `seed-agents/argus/` (agent-config.json, CLAUDE.md, SOUL.md). Boot-kor az `ensureSeedRoster()` scaffold-olja `agents/argus/`-ba, majd a dashboard **Start**-tal (vagy `POST /api/agents/argus/start`) indul.
- Modell: `claude-opus-4-8[1m]` — **beépített vision** (nincs külön vision-MCP) + 1M kontextus a hosszú átirathoz.
- Security profil: `media` (permissive) — engedi a `yt-dlp` + `ffmpeg` futtatását.
- Roster: `member`, `reportsTo: nexus`, accent amber (`#f59e0b`).

## Fő eszköz: `argus-youtube-watch` skill

`~/.claude/skills/argus-youtube-watch/SKILL.md` (seed: `seed-skills/argus-youtube-watch/`). A folyamat:

1. **Átirat**: `yt-dlp --write-auto-subs --write-subs --sub-lang "hu.*,en.*" --convert-subs vtt --skip-download` → a `.vtt`-t időbélyeges, deduplikált szöveggé normalizálja. (NE `.*` catch-all sub-lang → az ~100 nyelvet húzná le és HTTP 429-et kapna.)
2. **Kockák**: `yt-dlp -f "best[height<=480]"` letölti, majd `ffmpeg -vf "fps=1/STEP"` időtartam-adaptív mintavétellel ~30 kockát ment (hard cap 40). Az N. kocka időbélyege ≈ `(N-1)*STEP` mp.
3. **Vision**: ARGUS a `frame_*.jpg`-ket a saját látásával olvassa (Read tool) → időbélyeges vizuális megfigyelések.
4. **Fúzió**: átirat + kocka-megfigyelés → idővonal-tábla (`időbélyeg | elhangzott | látható`) + 5-8 mondatos vezetői összefoglaló + kulcs-tanulságok.
5. **Mentés**: a summary `shared` memóriába kerül (`keywords: youtube, <video-id>`), így a csapat újra tudja használni.
6. Takarítás (`/tmp/argus-<id>`) + visszajelzés NEXUS-nak.

## Függőségek

- **`ffmpeg` / `ffprobe`**: rendszerszinten telepítve (`/usr/bin`).
- **`yt-dlp`**: standalone binár a `~/.bun/bin/yt-dlp`-ben (ez a könyvtár az ügynök indító-PATH-ján van; `/usr/local/bin` nem írható sudo nélkül). Frissítés: `yt-dlp -U` vagy a binár újratöltése a GitHub release-ről.

## Használat

- **Operátor → NEXUS**: „foglald össze ezt a videót: <URL>". NEXUS a roster-szabály alapján ARGUS-nak delegálja (`POST /api/messages` from=nexus to=argus). *(NEXUS a frissített rostert a következő (újra)indításakor olvassa be.)*
- **Közvetlen**: `POST /api/messages` `{"from":"nexus","to":"argus","content":"... <URL> ..."}` — ARGUS futó tmux-session kell hozzá.

## Korlátok

- **Token-büdzsé**: a kockaszám korlátozott (cap 40); hosszú videónál nagyobb a lépésköz.
- **Felirat nélküli / korhatáros / régió-zárt videó**: yt-dlp hibázhat → ARGUS kocka-only elemzésre vált és jelzi a korlátot.
- **Nem hu/en nyelv**: alap a `hu.*,en.*`; más nyelvnél `yt-dlp --list-subs` után a konkrét nyelvkóddal újrafuttatható.
- **Letöltés**: `best[height<=480]` korlátozza a méretet; nagyon hosszú videónál `--download-sections` használható.

## Verifikáció (2026-06-09)

Élő teszt a B8QwIQo2H1g (~50 perc) videón: átirat 1258 sor, 36 kocka mintavételezve (STEP=83s),
a kockákból ARGUS helyesen olvasta ki a dashboard/skill-fül/kanban-tábla tartalmát, és átirat+kép
fúziós összefoglalót adott. A `media` profil + bypass-permissions miatt prompt nélkül futott.
