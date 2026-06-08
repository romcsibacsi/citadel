#!/usr/bin/env node
// ComfyUI MCP server (stdio) for CITADEL. Wired into the CREATIVE agent's
// .mcp.json; exposes image-generation tools that drive a ComfyUI server on the
// GPU box. The base URL is web-managed (Vault "Rendszer-integrációk" card,
// comfy_url) and read at runtime by the client.
//
// IMPORTANT: stdout is the JSON-RPC channel -- never console.log here. All
// diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { generateImage } from './comfy-generate.js'
import { generateFaceImage } from './comfy-face.js'
import { listCheckpoints, comfyStatus, ComfyError } from './comfy-client.js'

function errText(err: unknown): string {
  if (err instanceof ComfyError) return err.message
  return err instanceof Error ? err.message : String(err)
}

const server = new McpServer({ name: 'citadel-comfy', version: '1.0.0' })

server.registerTool('generate_image', {
  title: 'Kép generálása (ComfyUI)',
  description: 'Szöveg→kép generálás a homelab GPU-gépén futó ComfyUI-val. A kész képet a store/comfy mappába menti, és visszaadja az elérési utat (a képet a Read tool-lal megnézheted, vagy a csatorna-reply tool-lal elküldheted).',
  inputSchema: {
    prompt: z.string().describe('A kívánt kép leírása (angol prompt ajánlott a legtöbb modellhez).'),
    negative: z.string().optional().describe('Negatív prompt — mit kerüljön a kép.'),
    checkpoint: z.string().optional().describe('Modell-fájl neve; üresen az alapértelmezett/első elérhető.'),
    width: z.number().int().optional().describe('Szélesség px (alap 1024).'),
    height: z.number().int().optional().describe('Magasság px (alap 1024).'),
    steps: z.number().int().optional().describe('Sampling lépések (alap 28).'),
    cfg: z.number().optional().describe('CFG scale (alap 6).'),
    seed: z.number().int().optional().describe('Seed a reprodukálhatósághoz; üresen véletlen.'),
    batch: z.number().int().optional().describe('Képek száma egy futásban (1-4, alap 1).'),
  },
}, async (args) => {
  try {
    const r = await generateImage(args as any)
    const lines = [
      r.woke ? '⏻ A ComfyUI nem futott — automatikusan elindítottam (SSH-wake).' : '',
      `✅ ${r.savedPaths.length} kép generálva (${r.width}×${r.height}, ${r.steps} step, checkpoint: ${r.checkpoint}, seed: ${r.seed}).`,
      ...r.savedPaths.map(p => `  • ${p}`),
    ].filter(Boolean)
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Kép-generálás sikertelen: ${errText(err)}` }] }
  }
})

server.registerTool('generate_image_with_face', {
  title: 'Karakter-konzisztens kép (InstantID)',
  description: 'Egy referencia-arcfotó alapján generál képet úgy, hogy a SZEMÉLY arca konzisztens marad, de a jelenet/stílus a prompt szerinti. Így több különböző kép is ugyanarra a személyre hasonlít. A referencia a store/comfy, store/comfy-video vagy ~/incoming alól.',
  inputSchema: {
    reference_image: z.string().describe('A referencia-arcfotó pontos elérési útja (egy tiszta, szemből látszó arc a legjobb).'),
    prompt: z.string().describe('A kívánt jelenet/stílus (angol prompt ajánlott).'),
    negative: z.string().optional().describe('Negatív prompt.'),
    checkpoint: z.string().optional().describe('SDXL checkpoint (üresen az alapértelmezett).'),
    width: z.number().int().optional().describe('Szélesség px (alap 1016).'),
    height: z.number().int().optional().describe('Magasság px (alap 1016).'),
    steps: z.number().int().optional().describe('Lépések (alap 30).'),
    cfg: z.number().optional().describe('CFG (alap 4.5 — az InstantID alacsony CFG-t igényel).'),
    weight: z.number().optional().describe('Arc-azonosság erőssége 0-1 (alap 0.8; feljebb hűségesebb, lejjebb kreatívabb).'),
    seed: z.number().int().optional().describe('Seed; üresen véletlen.'),
  },
}, async (args) => {
  try {
    const a = args as any
    const r = await generateFaceImage({ ...a, referenceImage: a.reference_image })
    const lines = [
      r.woke ? '⏻ A ComfyUI nem futott — automatikusan elindítottam (SSH-wake).' : '',
      `✅ ${r.savedPaths.length} karakter-konzisztens kép (checkpoint: ${r.checkpoint}, arc-erősség: ${r.weight}, seed: ${r.seed}).`,
      ...r.savedPaths.map(p => `  • ${p}`),
    ].filter(Boolean)
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Karakter-konzisztens generálás sikertelen: ${err instanceof ComfyError ? err.message : (err instanceof Error ? err.message : String(err))}` }] }
  }
})

server.registerTool('list_checkpoints', {
  title: 'Elérhető modellek (checkpointok)',
  description: 'Listázza a ComfyUI szerveren elérhető checkpoint (modell) fájlokat.',
  inputSchema: {},
}, async () => {
  try {
    const c = await listCheckpoints()
    return { content: [{ type: 'text', text: c.length ? `Elérhető checkpointok:\n${c.map(x => '  • ' + x).join('\n')}` : 'Nincs telepített checkpoint a ComfyUI szerveren.' }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: errText(err) }] }
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
  process.stderr.write('[citadel-comfy] MCP server ready (stdio)\n')
}

main().catch((err) => {
  process.stderr.write(`[citadel-comfy] fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
