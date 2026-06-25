// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Files (Fájlok) view (BUILD-22): a safe embedded browser over the three media
 * roots (generated images, generated videos, uploads). Root switcher + breadcrumb
 * + a grid of folders/files with inline image thumbnails and a video lightbox;
 * per-file download + delete; drag/drop + file-pick upload into the uploads root.
 * The secret/state dir is not a root, so it is unreachable.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError, getToken } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Root { id: string; uploadable: boolean }
interface Entry { name: string; kind: 'dir' | 'file'; size: number; modified: string; ext: string; media: 'image' | 'video' | 'other' }

let curRoot = 'images';
let curPath = ''; // relative path within the root

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function rawUrl(root: string, path: string, download = false): string {
  return `/api/files/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${download ? '&download=1' : ''}&token=${encodeURIComponent(getToken())}`;
}
function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function lightbox(root: string, e: Entry, path: string): void {
  const backdrop = h('div', { class: 'modal-backdrop files-lightbox' });
  const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey); };
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  const media = e.media === 'video'
    ? h('video', { src: rawUrl(root, path), controls: true, autoplay: true, class: 'files-lb-media' })
    : h('img', { src: rawUrl(root, path), alt: e.name, class: 'files-lb-media' });
  backdrop.append(h('div', { class: 'modal files-lb' },
    h('div', { class: 'agent-modal-titlebar' },
      h('h2', null, e.name),
      h('button', { class: 'icon-btn', 'aria-label': t('files.close'), onclick: close }, '✕')),
    h('div', { class: 'files-lb-body' }, media),
    h('div', { class: 'modal-actions' },
      h('a', { class: 'primary', href: rawUrl(root, path, true), download: e.name }, icon('import', 14), t('files.download')),
    ),
  ));
  document.body.append(backdrop); document.body.classList.add('modal-open');
}

function render(host: HTMLElement, store: Store<AppState>, subpath: string[]): void {
  void store;
  // deep link: #files/<root>/<path...>
  if (subpath.length > 0 && subpath[0] !== '') { curRoot = subpath[0]!; curPath = subpath.slice(1).join('/'); }
  const reload = (): void => render(host, store, []);

  let roots: Root[] = [];
  const grid = h('div', { class: 'files-grid' }, h('div', { class: 'muted-note' }, t('files.loading')));
  const breadcrumb = h('div', { class: 'files-breadcrumb' });
  const rootBar = h('div', { class: 'files-rootbar' });

  const setLocation = (root: string, path: string): void => { curRoot = root; curPath = path; loadList(); };

  const renderRootBar = (): void => {
    mount(rootBar, ...roots.map((r) => h('button', {
      class: `chip files-root${r.id === curRoot ? ' active' : ''}`,
      onclick: () => setLocation(r.id, ''),
    }, t(`files.root.${r.id}`))));
  };

  const renderBreadcrumb = (): void => {
    const segs = curPath === '' ? [] : curPath.split('/');
    const crumbs: HTMLElement[] = [h('button', { class: 'files-crumb', onclick: () => setLocation(curRoot, '') }, t(`files.root.${curRoot}`))];
    let acc = '';
    for (const s of segs) {
      acc = joinPath(acc, s);
      const target = acc;
      crumbs.push(h('span', { class: 'files-crumb-sep' }, '/'));
      crumbs.push(h('button', { class: 'files-crumb', onclick: () => setLocation(curRoot, target) }, s));
    }
    mount(breadcrumb, ...crumbs);
  };

  const tile = (e: Entry): HTMLElement => {
    if (e.kind === 'dir') {
      return h('button', { class: 'file-tile file-dir', onclick: () => setLocation(curRoot, joinPath(curPath, e.name)) },
        h('div', { class: 'file-thumb file-thumb-folder' }, icon('folder', 28)),
        h('div', { class: 'file-name', title: e.name }, e.name));
    }
    const fullPath = joinPath(curPath, e.name);
    const thumb = e.media === 'image'
      ? h('img', { class: 'file-thumb-img', src: rawUrl(curRoot, fullPath), alt: e.name, loading: 'lazy' })
      : h('div', { class: `file-thumb file-thumb-${e.media}` }, icon(e.media === 'video' ? 'aperture' : 'folder', 26));
    const del = async (ev: Event): Promise<void> => {
      ev.stopPropagation();
      if (!window.confirm(t('files.deleteConfirm', { name: e.name }))) return;
      try { await api.delete(`/api/files?root=${encodeURIComponent(curRoot)}&path=${encodeURIComponent(fullPath)}`); toast(t('files.deleted')); loadList(); }
      catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
    };
    const card = h('div', { class: 'file-tile', role: 'button', onclick: () => lightbox(curRoot, e, fullPath) },
      e.media === 'image' ? h('div', { class: 'file-thumb file-thumb-image' }, thumb) : thumb,
      h('div', { class: 'file-name', title: e.name }, e.name),
      h('div', { class: 'file-meta muted-note' }, `${fmtSize(e.size)} · ${new Date(e.modified).toLocaleDateString(currentLocale())}`),
      h('button', { class: 'icon-btn danger file-del', title: t('files.delete'), onclick: (ev: Event) => void del(ev) }, '✕'),
    );
    return card;
  };

  const loadList = (): void => {
    renderRootBar(); renderBreadcrumb();
    mount(dropWrap, ...(uploadable() ? [dropZone] : [])); // upload only on an uploadable root
    void api.get<{ entries: Entry[] }>(`/api/files/list?root=${encodeURIComponent(curRoot)}&path=${encodeURIComponent(curPath)}`)
      .then((r) => {
        if (r.entries.length === 0) { mount(grid, h('div', { class: 'muted-note files-empty' }, t('files.empty'))); return; }
        mount(grid, ...r.entries.map(tile));
      })
      .catch((err) => mount(grid, h('div', { class: 'muted-note err' }, err instanceof ApiError ? err.message : t('files.loadError'))));
  };

  // --- upload (uploadable root only) ---
  const uploadOne = async (file: File): Promise<void> => {
    const url = `/api/files/upload?root=${encodeURIComponent(curRoot)}&path=${encodeURIComponent(curPath)}&name=${encodeURIComponent(file.name)}`;
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${getToken()}` }, body: file });
    if (!res.ok) { const b = (await res.json().catch(() => ({}))) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  };
  const doUpload = async (fileList: FileList | File[]): Promise<void> => {
    const files = [...fileList];
    if (files.length === 0) return;
    let ok = 0;
    for (const f of files) {
      try { await uploadOne(f); ok += 1; } catch (err) { toast(t('files.uploadFailed', { name: f.name, msg: err instanceof Error ? err.message : '' }), true); }
    }
    if (ok > 0) { toast(t('files.uploaded', { n: ok })); loadList(); }
  };
  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none', onchange: (e: Event) => { const el = e.target as HTMLInputElement; if (el.files) void doUpload(el.files); el.value = ''; } }) as HTMLInputElement;
  const dropZone = h('div', { class: 'files-dropzone' }, icon('import', 18), h('span', null, t('files.dropHint')), fileInput);
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag'); if (e.dataTransfer?.files) void doUpload(e.dataTransfer.files); });

  const uploadable = (): boolean => roots.find((r) => r.id === curRoot)?.uploadable === true;
  const dropWrap = h('div', { class: 'files-upload-wrap' });

  void api.get<{ roots: Root[] }>('/api/files/roots').then((r) => {
    roots = r.roots;
    if (!roots.some((x) => x.id === curRoot)) curRoot = roots[0]?.id ?? 'images';
    mount(dropWrap, ...(uploadable() ? [dropZone] : []));
    loadList();
  }).catch(() => mount(grid, h('div', { class: 'muted-note err' }, t('files.loadError'))));

  mount(host,
    h('div', { class: 'page-header files-header' },
      h('div', null, h('h1', null, t('files.title')), h('p', { class: 'subtitle' }, t('files.subtitle'))),
      h('button', { class: 'secondary', title: t('files.upload'), onclick: () => { if (!uploadable()) { const up = roots.find((r) => r.uploadable); if (up) setLocation(up.id, ''); } fileInput.click(); } }, icon('import', 16), t('files.upload')),
    ),
    rootBar,
    breadcrumb,
    dropWrap,
    grid,
  );
}

defineView('files', 'nav.files', render);
