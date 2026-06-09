---
name: argus-youtube-watch
description: Watch and summarize an external (YouTube) video using BOTH its transcript AND sampled video frames read with vision. Use when the operator/NEXUS gives a video URL and asks for a summary, analysis, or "what's in this video" -- not just the transcript. ARGUS's primary workflow.
---
# ARGUS YouTube watch (transcript + frames)

## Mikor használd
- Az operátor vagy NEXUS ad egy videó-URL-t (jellemzően YouTube) és összefoglalót/elemzést kér.
- Amikor a felirat önmagában nem elég: látni kell, mi VAN a képen (demók, UI, diagramok, arcok).
- NEM erre való: saját draft-videó vágása/elemzése (az SCREENER), videó generálása (REEL/CREATIVE).

## Eljárás

Dolgozz egy ideiglenes mappában, és a végén takaríts. `URL` és `VID` (a videó id) a bemenet.

### 1. Setup
```bash
URL="<a kért URL>"
VID="$(yt-dlp --get-id "$URL" 2>/dev/null | head -1)"; [ -z "$VID" ] && VID="vid"
WD="/tmp/argus-$VID"; mkdir -p "$WD"; cd "$WD"
```

### 2. Átirat (felirat)
```bash
# FONTOS: NE használj ".*" catch-all sub-lang-ot -> az MIND a ~100 nyelvet letölti és HTTP 429-et kapsz.
# Csak hu/en variánsok. Ha a videó más nyelvű, a kész feliratot úgyis megkapod ("-orig"), vagy futtasd
# újra a detektált nyelvvel (lásd Buktatók).
yt-dlp "$URL" --write-auto-subs --write-subs --sub-lang "hu.*,en.*" \
  --convert-subs vtt --skip-download -o "%(id)s.%(ext)s" 2>&1 | tail -3
# normalizálás: idobelyeg + szoveg, tag-ek es duplikatumok nelkul
ls *.vtt 2>/dev/null && python3 - "$VID" <<'PY'
import sys,glob,re
vtt=sorted(glob.glob("*.vtt"))
if not vtt: sys.exit(0)
seen=set(); out=[]
for line in open(vtt[0],encoding="utf-8",errors="ignore"):
    line=line.strip()
    m=re.match(r"(\d{2}:\d{2}):\d{2}\.\d+ -->", line)  # mm:ss
    if m: ts=m.group(1)
    elif line and "-->" not in line and not line.isdigit() and line!="WEBVTT":
        t=re.sub(r"<[^>]+>","",line).strip()
        if t and t not in seen: seen.add(t); out.append(f"[{ts}] {t}")
open("transcript.txt","w",encoding="utf-8").write("\n".join(out))
print(f"transcript: {len(out)} sor")
PY
```
Ha NINCS .vtt (felirat letiltva/korhatáros): jelezd, és menj tovább KOCKA-alapú elemzésre.

### 3. Képkockák mintavétele (KORLÁTOZOTT számban)
Időtartam-adaptív egyenletes mintavétel, hogy az időbélyeg számolható legyen ÉS a kockaszám korlátos:
```bash
yt-dlp "$URL" -f "best[height<=480]/best" -o "video.%(ext)s" 2>&1 | tail -2
V="$(ls video.* | head -1)"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V" | cut -d. -f1)"
# cel: ~30 kocka, de min 15s lepes; FRAMES hard cap = 40
STEP=$(( DUR/30 )); [ "$STEP" -lt 15 ] && STEP=15
ffmpeg -hide_banner -loglevel error -i "$V" -vf "fps=1/$STEP" -frames:v 40 frame_%03d.jpg
echo "STEP=${STEP}s, kockak: $(ls frame_*.jpg | wc -l)"
```
Az `N`. kocka (`frame_00N.jpg`) időbélyege ≈ `(N-1) * STEP` másodperc -> mm:ss.

### 4. Kockák olvasása (vision)
A `frame_*.jpg` fájlokat a SAJÁT látásoddal olvasd (Read tool mindegyikre). Minden kockához írj 1 rövid
vizuális megfigyelést a számolt időbélyeggel (pl. `[06:00] terminál tmux-panelekkel, kanban tábla`).
Ne olvasd kétszer ugyanazt; ha sok a kocka, a token-büdzsé miatt a legjellemzőbbeket nézd.

### 5. Fúzió -> összefoglaló
Vesd össze a `transcript.txt`-t a kocka-megfigyelésekkel, és állíts elő:
- **Idővonal-tábla**: `| időbélyeg | elhangzott (rövid) | látható |`
- **Vezetői összefoglaló**: 5-8 mondat, mi a videó és mi a lényege.
- **Kulcs-tanulságok**: 3-6 pont (és ha releváns: mi alkalmazható a mi rendszerünkre).
A megfigyelést különítsd el a véleménytől; ahol csak az átirat vagy csak a kocka az alap, jelezd.

### 6. Mentés megosztott memóriába
```bash
curl -s -X POST http://localhost:3420/api/memories \
  -H "Content-Type: application/json" -H "Authorization: Bearer $(cat /home/uplinkfather/CITADEL/citadel/store/.dashboard-token)" \
  -d "{\"agent_id\":\"argus\",\"content\":\"YouTube: <cím> ($VID) -- <3-4 mondatos lényeg>\",\"category\":\"shared\",\"keywords\":\"youtube, $VID\"}"
```

### 7. Takarítás + visszajelzés
```bash
rm -rf "$WD"
```
Add vissza az összefoglalót az operátornak / NEXUS-nak (inter-agent message, ha NEXUS kérte).

## Buktatók
- **Token-büdzsé**: a kockaszámot KORLÁTOZD (hard cap 40). Hosszú videónál nagyobb STEP.
- **Nincs felirat / korhatáros / régió-zár**: yt-dlp hibázhat -> kocka-only elemzés, és jelezd a korlátot.
- **Nyelv**: alap a `hu.*,en.*`. Ha a videó más nyelvű és nincs hu/en felirat, listázd (`yt-dlp --list-subs "$URL"`), és futtasd újra a konkrét nyelvkóddal (pl. `--sub-lang "de.*"`). SOHA ne `.*` (429).
- **Lassú letöltés / nagy fájl**: `best[height<=480]` korlátozza; ha így is nagy, csak az első X percet húzd le (`--download-sections "*0-600"`).
- **Idő-konverzió**: a kocka-időbélyeg a VIDEÓ idővonala (mm:ss), nem naptári idő.

## Ellenőrzés
- Az összefoglaló MINDKÉT forrásra hivatkozik (átirat idézet + vizuális megfigyelés), időbélyegekkel.
- A `/tmp/argus-$VID` mappa törölve.
- A megosztott memória sor megszületett (`GET /api/memories?q=$VID` visszaadja).
