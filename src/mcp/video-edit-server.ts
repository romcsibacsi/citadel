#!/usr/bin/env node
// Video-editing MCP server (stdio) for CITADEL. Wired into the editor agent
// (CREATIVE). Deterministic ffmpeg ops on the generated media -> reliable; safe
// for any content (it transcodes files, never "reads" them).
//
// IMPORTANT: stdout is the JSON-RPC channel -- never console.log here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { concatVideos, trimVideo, extractFrame, videoInfo, imagesToVideo, VideoEditError } from './video-edit.js'

function errText(err: unknown): string {
  if (err instanceof VideoEditError) return err.message
  return err instanceof Error ? err.message : String(err)
}

const server = new McpServer({ name: 'citadel-video-edit', version: '1.0.0' })

server.registerTool('concat_videos', {
  title: 'Videók összefűzése',
  description: 'Több videót egymás után fűz egyetlen mp4-be (a store/comfy-video mappába). Add meg a fájlok pontos elérési útját a kívánt sorrendben.',
  inputSchema: { paths: z.array(z.string()).min(2).describe('A videók elérési útjai sorrendben (min. 2).') },
}, async (args) => {
  try {
    const out = await concatVideos((args as { paths: string[] }).paths)
    return { content: [{ type: 'text', text: `✅ Összefűzve: ${out}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Összefűzés sikertelen: ${errText(err)}` }] }
  }
})

server.registerTool('images_to_video', {
  title: 'Diavetítés-videó képekből',
  description: 'Állóképekből készít egy videót (mindegyik kép `seconds_per_image` ideig látszik), 1280×720-ra normálva. Pl. MUSE generált képeiből egy klip.',
  inputSchema: {
    paths: z.array(z.string()).min(1).describe('A képek elérési útjai a kívánt sorrendben.'),
    seconds_per_image: z.number().optional().describe('Hány másodpercig látszik egy kép (alap 3).'),
  },
}, async (args) => {
  try {
    const a = args as { paths: string[]; seconds_per_image?: number }
    const out = await imagesToVideo(a.paths, a.seconds_per_image ?? 3)
    return { content: [{ type: 'text', text: `✅ Diavetítés kész: ${out}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Diavetítés sikertelen: ${errText(err)}` }] }
  }
})

server.registerTool('trim_video', {
  title: 'Videó vágása (részlet kivétele)',
  description: 'Kivág egy [start, start+hossz] szakaszt egy videóból új mp4-be (store/comfy-video).',
  inputSchema: {
    path: z.string().describe('A forrásvideó elérési útja.'),
    start: z.number().describe('Kezdőpont másodpercben.'),
    duration: z.number().describe('A kivágott rész hossza másodpercben.'),
  },
}, async (args) => {
  try {
    const a = args as { path: string; start: number; duration: number }
    const out = await trimVideo(a.path, a.start, a.duration)
    return { content: [{ type: 'text', text: `✅ Kivágva: ${out}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Vágás sikertelen: ${errText(err)}` }] }
  }
})

server.registerTool('extract_frame', {
  title: 'Kocka kivétele videóból (kép)',
  description: 'Egyetlen képkockát ment ki PNG-ként a megadott időpontban (a store/comfy mappába).',
  inputSchema: {
    path: z.string().describe('A forrásvideó elérési útja.'),
    time: z.number().describe('Az időpont másodpercben.'),
  },
}, async (args) => {
  try {
    const a = args as { path: string; time: number }
    const out = await extractFrame(a.path, a.time)
    return { content: [{ type: 'text', text: `✅ Kocka mentve: ${out}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Kockakivétel sikertelen: ${errText(err)}` }] }
  }
})

server.registerTool('video_info', {
  title: 'Videó infó (hossz, méret, codec)',
  description: 'Megadja egy videó hosszát (mp), felbontását és codec-jét.',
  inputSchema: { path: z.string().describe('A videó elérési útja.') },
}, async (args) => {
  try {
    const i = await videoInfo((args as { path: string }).path)
    return { content: [{ type: 'text', text: `⏱ ${i.duration.toFixed(2)}s · ${i.width}×${i.height} · ${i.codec}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: errText(err) }] }
  }
})

async function main() {
  await server.connect(new StdioServerTransport())
  process.stderr.write('[citadel-video-edit] MCP server ready (stdio)\n')
}

main().catch((err) => {
  process.stderr.write(`[citadel-video-edit] fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
