#!/usr/bin/env node
// ComfyUI video MCP server (stdio) for CITADEL. Wired into the REEL agent's
// .mcp.json; drives the Wan 2.2 TI2V-5B model on the homelab GPU box for
// text->video and image->video. Base URL is the same web-managed comfy_url.
//
// IMPORTANT: stdout is the JSON-RPC channel -- never console.log here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { generateVideo } from './comfy-video.js'
import { comfyStatus, ComfyError } from './comfy-client.js'

function errText(err: unknown): string {
  if (err instanceof ComfyError) return err.message
  return err instanceof Error ? err.message : String(err)
}

const server = new McpServer({ name: 'citadel-comfy-video', version: '1.0.0' })

const commonShape = {
  negative: z.string().optional().describe('Negatív prompt — mit kerüljön a videó.'),
  width: z.number().int().optional().describe('Szélesség px (alap 1280).'),
  height: z.number().int().optional().describe('Magasság px (alap 704).'),
  frames: z.number().int().optional().describe('Képkockák száma (5-121, alap 49; 24 fps-nél 49≈2s, 121≈5s).'),
  fps: z.number().int().optional().describe('Képkocka/mp (alap 24).'),
  steps: z.number().int().optional().describe('Sampling lépések (alap 30).'),
  cfg: z.number().optional().describe('CFG scale (alap 5).'),
  seed: z.number().int().optional().describe('Seed a reprodukálhatósághoz; üresen véletlen.'),
}

function formatResult(r: Awaited<ReturnType<typeof generateVideo>>): string {
  return [
    r.woke ? '⏻ A ComfyUI nem futott — automatikusan elindítottam (SSH-wake).' : '',
    r.freedVram ? '🧹 VRAM felszabadítva a videó-generáláshoz (LLM kiléptetve — a következő üzenetnél újratöltődik).' : '',
    `✅ Videó kész (${r.mode === 'i2v' ? 'kép→videó' : 'szöveg→videó'}, ${r.width}×${r.height}, ${r.frames} kocka @ ${r.fps} fps, seed: ${r.seed}).`,
    `  • ${r.savedPath}`,
  ].filter(Boolean).join('\n')
}

server.registerTool('generate_video', {
  title: 'Videó generálása szövegből (Wan 2.2)',
  description: 'Szöveg→videó a homelab GPU-gépén futó ComfyUI Wan 2.2 modelljével. A kész mp4-et a store/comfy-video mappába menti, és visszaadja az elérési utat.',
  inputSchema: {
    prompt: z.string().describe('A kívánt videó leírása (angol prompt ajánlott; mozgás/kameramozgás leírása sokat segít).'),
    ...commonShape,
  },
}, async (args) => {
  try {
    const r = await generateVideo(args as any)
    return { content: [{ type: 'text', text: formatResult(r) }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Videó-generálás sikertelen: ${errText(err)}` }] }
  }
})

server.registerTool('animate_image', {
  title: 'Kép animálása videóvá (Wan 2.2, image→video)',
  description: 'Egy meglévő képből (store/comfy, store/comfy-video vagy ~/incoming) indít mozgóképet a prompt szerint. A kész mp4-et a store/comfy-video mappába menti.',
  inputSchema: {
    image_path: z.string().describe('A kiindulási kép pontos elérési útja (store/comfy/... vagy ~/incoming/...).'),
    prompt: z.string().describe('Hogyan mozogjon/változzon a kép (angol prompt ajánlott).'),
    ...commonShape,
  },
}, async (args) => {
  try {
    const a = args as any
    const r = await generateVideo({ ...a, imagePath: a.image_path })
    return { content: [{ type: 'text', text: formatResult(r) }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Kép→videó sikertelen: ${errText(err)}` }] }
  }
})

server.registerTool('comfy_status', {
  title: 'ComfyUI állapot',
  description: 'Ellenőrzi, hogy a beállított ComfyUI szerver elérhető-e.',
  inputSchema: {},
}, async () => {
  try {
    await comfyStatus()
    return { content: [{ type: 'text', text: 'A ComfyUI szerver elérhető.' }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: errText(err) }] }
  }
})

async function main() {
  await server.connect(new StdioServerTransport())
  process.stderr.write('[citadel-comfy-video] MCP server ready (stdio)\n')
}

main().catch((err) => {
  process.stderr.write(`[citadel-comfy-video] fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
