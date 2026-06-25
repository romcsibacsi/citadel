// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Shared drag/drop reader for skill imports (FIX-03 §6 / FIX-10 §6). Reads a
 * dropped folder or files into {rel, content} pairs for POST /api/skills/import-files,
 * which materializes them into a temp dir and runs the hardened importSkillDir.
 * A single dropped folder is flattened so its SKILL.md sits at the root. Binary
 * .zip/.tar.gz archives are DEFERRED (no zero-dep parser).
 */

export interface DroppedFile { rel: string; content: string }

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((res, rej) => entry.file(res, rej));
}
async function dirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}
async function walkEntry(entry: FileSystemEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    out.push({ rel: prefix + entry.name, content: await file.text() });
  } else if (entry.isDirectory) {
    for (const e of await dirEntries((entry as FileSystemDirectoryEntry).createReader())) {
      await walkEntry(e, `${prefix}${entry.name}/`, out);
    }
  }
}

export async function collectDrop(dt: DataTransfer): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const entries = Array.from(dt.items)
    .map((it) => it.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 1 && entries[0]!.isDirectory) {
    for (const e of await dirEntries((entries[0] as FileSystemDirectoryEntry).createReader())) await walkEntry(e, '', out);
  } else if (entries.length > 0) {
    for (const e of entries) await walkEntry(e, '', out);
  } else {
    for (const f of Array.from(dt.files)) out.push({ rel: f.name, content: await f.text() });
  }
  return out;
}
