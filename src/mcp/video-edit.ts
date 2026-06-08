// Deterministic ffmpeg-based video editing for CITADEL (runs on uplinkserver,
// where the generated media lives). Content-agnostic file ops -> reliable, no
// LLM/gen flakiness. Used by the editor agent (CREATIVE) to combine/trim/extract
// what MUSE/REEL produced. Inputs are path-restricted to the media roots.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'

const execFileAsync = promisify(execFile)

export class VideoEditError extends Error {}

const VIDEO_DIR = join(PROJECT_ROOT, 'store', 'comfy-video')
const IMAGE_DIR = join(PROJECT_ROOT, 'store', 'comfy')
const ALLOWED = [IMAGE_DIR, VIDEO_DIR, join(homedir(), 'incoming')]

// Resolve + confine an input path to the media roots (realpath, anti-traversal).
function resolveInput(p: string): string {
  let real: string
  try { real = realpathSync(p) } catch { throw new VideoEditError(`Nem található: ${p}`) }
  const ok = ALLOWED.some(b => {
    try { const rb = realpathSync(b); return real === rb || real.startsWith(rb + sep) } catch { return false }
  })
  if (!ok) throw new VideoEditError('A fájl csak store/comfy, store/comfy-video vagy ~/incoming alól vehető.')
  return real
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    throw new VideoEditError(`ffmpeg hiba: ${(err.stderr || err.message || String(e)).slice(0, 400)}`)
  }
}

function stampedOut(dir: string, suffix: string): string {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dir, `${stamp}_${suffix}`)
}

// Concatenate clips into one mp4. Tries stream-copy (fast, same-codec Wan clips);
// falls back to re-encode if the inputs differ.
export async function concatVideos(paths: string[]): Promise<string> {
  if (!Array.isArray(paths) || paths.length < 2) throw new VideoEditError('Legalább 2 videó kell az összefűzéshez.')
  const reals = paths.map(resolveInput)
  const listFile = join(tmpdir(), `concat-${randomBytes(4).toString('hex')}.txt`)
  writeFileSync(listFile, reals.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))
  const out = stampedOut(VIDEO_DIR, 'concat.mp4')
  try {
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out])
  } catch {
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out])
  }
  return out
}

// Cut a [start, start+duration] segment out of a video (re-encoded for accuracy).
export async function trimVideo(path: string, startSec: number, durationSec: number): Promise<string> {
  const real = resolveInput(path)
  const out = stampedOut(VIDEO_DIR, 'trim.mp4')
  await ffmpeg(['-ss', String(Math.max(0, startSec)), '-i', real, '-t', String(Math.max(0.1, durationSec)), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out])
  return out
}

// Grab a single frame at `timeSec` as a PNG (saved into the images root).
export async function extractFrame(path: string, timeSec: number): Promise<string> {
  const real = resolveInput(path)
  const out = stampedOut(IMAGE_DIR, 'frame.png')
  await ffmpeg(['-ss', String(Math.max(0, timeSec)), '-i', real, '-vframes', '1', out])
  return out
}

// Build a slideshow video from still images (each shown `secondsPerImage`),
// normalised to 1280x720. Lets the editor turn MUSE's images into a clip.
export async function imagesToVideo(paths: string[], secondsPerImage = 3): Promise<string> {
  if (!Array.isArray(paths) || paths.length < 1) throw new VideoEditError('Legalább 1 kép kell.')
  const reals = paths.map(resolveInput)
  const dur = Math.max(0.5, secondsPerImage)
  const listFile = join(tmpdir(), `slides-${randomBytes(4).toString('hex')}.txt`)
  const lines: string[] = []
  for (const p of reals) {
    const esc = p.replace(/'/g, "'\\''")
    lines.push(`file '${esc}'`, `duration ${dur}`)
  }
  // concat demuxer needs the last image repeated (its duration is otherwise dropped).
  lines.push(`file '${reals[reals.length - 1].replace(/'/g, "'\\''")}'`)
  writeFileSync(listFile, lines.join('\n'))
  const out = stampedOut(VIDEO_DIR, 'slideshow.mp4')
  await ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
  ])
  return out
}

export interface MediaInfo { duration: number; width: number; height: number; codec: string }

export async function videoInfo(path: string): Promise<MediaInfo> {
  const real = resolveInput(path)
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', real,
    ], { timeout: 30_000 })
    const j = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number; codec_name?: string }>; format?: { duration?: string } }
    const s = (j.streams || [])[0] || {}
    return { duration: parseFloat(j.format?.duration || '0'), width: s.width || 0, height: s.height || 0, codec: s.codec_name || '' }
  } catch (e) {
    throw new VideoEditError(`ffprobe hiba: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
  }
}
