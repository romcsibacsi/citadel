// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Studio (Stúdió) view (PROMPT-19): a one-box, plain-language media generator. A
 * composer (mode toggle, request box, preset chips, fine-settings modal), the
 * async submit→poll→result flow (job id persisted for refresh re-attach), a live
 * status line, a results gallery (image lightbox / inline video), a tool-log
 * disclosure, and a ComfyUI reachability indicator. Operator-only.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError, getToken } from '../api.js';
import { icon } from '../icons.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type Mode = 'image' | 'video';
interface Job { status: string; progress: string; elapsed: number; reply?: string; files?: string[]; log?: string[]; error?: string }

const hu = (): boolean => currentLocale().startsWith('hu');
const pick = (a: string, b: string): string => (hu() ? a : b);
const JOB_KEY = 'studio.job';

// [hu, en, payload]
const STYLE: Array<[string, string, string]> = [
  ['Fotorealisztikus', 'Photorealistic', 'photorealistic, sharp focus, natural lighting, 85mm'],
  ['Hiperrealisztikus', 'Hyperrealistic', 'hyperrealistic, extreme detail, ultra sharp, photorealistic, 8k'],
  ['Filmes', 'Cinematic', 'cinematic mood, high contrast, dramatic lighting, film grain'],
  ['Anime', 'Anime', 'anime style, vivid colors, clean lines, cel shading'],
  ['Cartoon', 'Cartoon', 'cartoon style, bold outlines, flat vivid colors'],
  ['Pixar', 'Pixar', 'Pixar-style 3D animation, stylized character, soft lighting'],
  ['Képregény', 'Comic', 'comic book style, ink outlines, halftone shading'],
  ['Festmény', 'Painting', 'digital painting, visible brushstrokes, artistic'],
  ['Akvarell', 'Watercolor', 'watercolor painting, soft washes, paper texture'],
  ['3D render', '3D render', '3D render, detailed, octane render'],
  ['Koncept-art', 'Concept art', 'concept art, digital illustration, atmospheric, detailed'],
  ['Retró', 'Retro', 'retro, vintage, 70s color palette'],
  ['Noir', 'Noir', 'black and white, film noir, strong shadows'],
];
const MOTION: Array<[string, string, string]> = [
  ['Ráközelítés', 'Zoom in', 'slow camera zoom-in toward the subject'],
  ['Kihúzás', 'Zoom out', 'camera slowly pulls back'],
  ['Követő snitt', 'Tracking shot', 'tracking camera move following the subject'],
  ['Körbe', 'Orbit', 'orbiting camera move around the subject'],
  ['Panoráma', 'Pan', 'slow side pan with the camera'],
  ['Statikus', 'Static', 'static camera, only the subject moves'],
  ['Kézikamera', 'Handheld', 'slight handheld camera shake, documentary feel'],
];
const SIZE: Array<[string, string, number, number]> = [
  ['Négyzet 1:1', 'Square 1:1', 1024, 1024],
  ['Álló 2:3', 'Portrait 2:3', 832, 1216],
  ['Fekvő 3:2', 'Landscape 3:2', 1216, 832],
  ['Videó 16:9', 'Video 16:9', 1280, 720],
  ['Videó 9:16', 'Video 9:16', 720, 1280],
];
const QUALITY: Array<[string, string, string]> = [['Gyors', 'Fast', 'fast'], ['Normál', 'Normal', 'normal'], ['Magas', 'High', 'high'], ['Pontos', 'Accurate', 'accurate']];
const LENGTH: Array<[string, string, number]> = [['2 mp', '2 s', 2], ['3 mp', '3 s', 3], ['5 mp', '5 s', 5]];
const STEPS: Record<Mode, Record<string, number>> = { image: { fast: 20, normal: 30, high: 45, accurate: 60 }, video: { fast: 4, normal: 6, high: 8, accurate: 20 } };
const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const VID_EXT = /\.(mp4|webm)$/i;
const POLL_CAP_SECONDS = 45 * 60; // §6.2 wall-clock cap: stop polling a job stuck running this long
const WAKE_INTERVAL_MS = 10_000; // §6.10 waking re-probe cadence
const WAKE_MAX_ATTEMPTS = 9; // ~90s total, within the spec's ~1–2 min window

let mode: Mode = 'image';
let qualityLevel = '';
let polling = false;
let videoModel: '14b' | '5b' = '14b'; // FIX-studio-2 §1: A14B default / 5B fast
let sourceImage = ''; // i2v source (relative name under the generated-images root)
let sourceLabel = '';
let faceImage = ''; // FIX-studio-3: InstantID reference face (root:name under an allow-listed root)
let faceLabel = '';
let faceWeight = 0.8; // identity strength (0..1)
let workflow = ''; // FIX-plugin-comfy-workflows: '' = txt2img; else img2img/upscale/inpaint/bg-removal/controlnet-pose
let loraName = ''; // optional LoRA for the txt2img path

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  const settings: { width?: number; height?: number; seconds?: number; steps?: number; cfg?: number; seed?: number; negative?: string } = {};

  const textarea = h('textarea', { class: 'studio-prompt', rows: 3, placeholder: pick('Pl.: Csinálj 3 képet egy retró robotról különböző pózokban, majd fűzd őket egy diavetítés-videóba.', 'E.g.: Make 3 images of a retro robot in different poses, then stitch them into a slideshow video.') }) as HTMLTextAreaElement;
  const statusLine = h('div', { class: 'studio-status', style: 'display:none' });
  const gallery = h('div', { class: 'studio-gallery' });
  const logBody = h('div', { class: 'studio-log-body' });
  const startBtn = h('button', { class: 'primary' }, t('studio.start')) as HTMLButtonElement;

  // ---- chip groups ----
  const styleChips: HTMLButtonElement[] = [];
  const motionChips: HTMLButtonElement[] = [];
  const sizeChips: HTMLButtonElement[] = [];
  const qualityChips: HTMLButtonElement[] = [];
  const lengthChips: HTMLButtonElement[] = [];
  const customSec = h('input', { type: 'number', class: 'studio-custom-sec', min: 1, max: 60, step: 0.5, placeholder: pick('egyéni mp', 'custom s') }) as HTMLInputElement;

  const phrasePresent = (p: string): boolean => textarea.value.includes(p);
  const removePhrase = (p: string): void => { textarea.value = textarea.value.replace(new RegExp(`(,\\s*)?${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '').replace(/^,\s*/, '').trim(); };
  const addPhrase = (p: string): void => { textarea.value = textarea.value.trim() === '' ? p : `${textarea.value.trim()}, ${p}`; };
  const togglePhrase = (p: string): void => {
    if (phrasePresent(p)) removePhrase(p); else addPhrase(p);
    syncChips();
  };
  // FIX-studio-brain §C: style is SINGLE-SELECT — one primary style, never two
  // contradictory ones (e.g. "Hiperrealisztikus" + "Cartoon") in the same prompt.
  const selectStyle = (p: string): void => {
    const wasActive = phrasePresent(p);
    for (const c of STYLE) if (phrasePresent(c[2])) removePhrase(c[2]); // clear any active style
    if (!wasActive) addPhrase(p);
    syncChips();
  };
  const syncChips = (): void => {
    STYLE.forEach((c, i) => styleChips[i]!.classList.toggle('active', phrasePresent(c[2])));
    MOTION.forEach((c, i) => motionChips[i]!.classList.toggle('active', phrasePresent(c[2])));
    SIZE.forEach((c, i) => sizeChips[i]!.classList.toggle('active', settings.width === c[2] && settings.height === c[3]));
    QUALITY.forEach((c, i) => qualityChips[i]!.classList.toggle('active', qualityLevel === c[2]));
    LENGTH.forEach((c, i) => lengthChips[i]!.classList.toggle('active', settings.seconds === c[2] && customSec.value === ''));
  };
  textarea.addEventListener('input', syncChips);

  const chipGroup = (labelKey: string, buttons: HTMLButtonElement[], extra?: HTMLElement, hideInImage = false): HTMLElement => {
    const grp = h('div', { class: `studio-chip-group${hideInImage && mode === 'image' ? ' hidden' : ''}`, 'data-video-only': hideInImage ? '1' : '0' },
      h('div', { class: 'studio-chip-label' }, t(labelKey)),
      h('div', { class: 'studio-chips' }, ...buttons, ...(extra ? [extra] : [])));
    return grp;
  };

  STYLE.forEach((c) => { const b = h('button', { class: 'chip', onclick: () => selectStyle(c[2]) }, pick(c[0], c[1])) as HTMLButtonElement; styleChips.push(b); });
  MOTION.forEach((c) => { const b = h('button', { class: 'chip', onclick: () => togglePhrase(c[2]) }, pick(c[0], c[1])) as HTMLButtonElement; motionChips.push(b); });
  SIZE.forEach((c) => { const b = h('button', { class: 'chip', onclick: () => { if (settings.width === c[2] && settings.height === c[3]) { delete settings.width; delete settings.height; } else { settings.width = c[2]; settings.height = c[3]; } syncChips(); } }, pick(c[0], c[1])) as HTMLButtonElement; sizeChips.push(b); });
  QUALITY.forEach((c) => { const b = h('button', { class: 'chip', title: c[2] === 'accurate' ? pick('Videónál: Lightning nélkül, több step → jobb prompt-/kamera-követés (lassabb)', 'Video: no Lightning, more steps → better prompt/camera adherence (slower)') : '', onclick: () => { if (qualityLevel === c[2]) { qualityLevel = ''; delete settings.steps; } else { qualityLevel = c[2]; settings.steps = STEPS[mode][c[2]]; } syncChips(); } }, pick(c[0], c[1])) as HTMLButtonElement; qualityChips.push(b); });
  LENGTH.forEach((c) => { const b = h('button', { class: 'chip', onclick: () => { if (settings.seconds === c[2] && customSec.value === '') { delete settings.seconds; } else { settings.seconds = c[2]; customSec.value = ''; } syncChips(); } }, pick(c[0], c[1])) as HTMLButtonElement; lengthChips.push(b); });
  customSec.addEventListener('input', () => { const n = Number(customSec.value); if (customSec.value !== '' && Number.isFinite(n) && n > 0) settings.seconds = n; else delete settings.seconds; syncChips(); });

  // ---- chip groups (built now so the mode toggle can show/hide in place) ----
  const motionGroup = chipGroup('studio.group.motion', motionChips, undefined, true);
  const lengthGroup = chipGroup('studio.group.length', lengthChips, customSec, true);

  // FIX-studio-2 §1: model toggle (A14B default / 5B fast) — video only
  const a14Btn = h('button', { class: 'chip', onclick: () => { videoModel = '14b'; syncModel(); } }, pick('A14B (jobb)', 'A14B (better)')) as HTMLButtonElement;
  const b5Btn = h('button', { class: 'chip', onclick: () => { videoModel = '5b'; syncModel(); } }, pick('5B (gyors)', '5B (fast)')) as HTMLButtonElement;
  const syncModel = (): void => { a14Btn.classList.toggle('active', videoModel === '14b'); b5Btn.classList.toggle('active', videoModel === '5b'); };
  syncModel();
  const modelGroup = chipGroup('studio.group.model', [a14Btn, b5Btn], undefined, true);

  // FIX-studio-2 §1: source-image picker (i2v) — pick a still from the generated images
  const sourceChip = h('span', { class: 'studio-source-chip' });
  const renderSource = (): void => {
    mount(sourceChip, ...(sourceImage !== ''
      ? [h('span', { class: 'badge on' }, `i2v: ${sourceLabel}`), h('button', { class: 'btn-mini', title: t('studio.source.clear'), onclick: () => { sourceImage = ''; sourceLabel = ''; renderSource(); } }, '✕')]
      : [h('span', { class: 'muted-note' }, t('studio.source.none'))]));
  };
  renderSource();
  const sourceGroup = chipGroup('studio.group.source', [h('button', { class: 'chip', onclick: () => openSourcePicker() }, t('studio.source.pick')) as HTMLButtonElement], sourceChip, true);

  const videoGroups = [modelGroup, motionGroup, lengthGroup, sourceGroup];

  // FIX-studio-3 §4: reference-face picker + identity strength — IMAGE mode only.
  // A reference routes the run to the InstantID (character-consistent) face graph.
  const faceChip = h('span', { class: 'studio-face-chip' });
  const weightInput = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: String(faceWeight), class: 'studio-weight' }) as HTMLInputElement;
  const weightVal = h('span', { class: 'studio-weight-val' }, faceWeight.toFixed(2));
  const weightRow = h('div', { class: 'studio-weight-row hidden' },
    h('span', { class: 'studio-chip-label' }, t('studio.face.weight')), weightInput, weightVal);
  weightInput.addEventListener('input', () => { faceWeight = Number(weightInput.value); weightVal.textContent = faceWeight.toFixed(2); });
  // visibility via the shared `.hidden` class (not inline style) so a video-mode
  // switch can never leak the row past an inline display value (review fold-in).
  function updateFaceVisibility(): void { weightRow.classList.toggle('hidden', !(mode === 'image' && faceImage !== '')); }
  const renderFace = (): void => {
    mount(faceChip, ...(faceImage !== ''
      ? [h('span', { class: 'badge on' }, `face: ${faceLabel}`), h('button', { class: 'btn-mini', title: t('studio.face.clear'), onclick: () => { faceImage = ''; faceLabel = ''; renderFace(); } }, '✕')]
      : [h('span', { class: 'muted-note' }, t('studio.face.none'))]));
    updateFaceVisibility();
  };
  renderFace();
  const faceGroup = chipGroup('studio.group.face', [h('button', { class: 'chip', onclick: () => openFacePicker() }, t('studio.face.pick')) as HTMLButtonElement], faceChip);

  // FIX-plugin-comfy-workflows: workflow pack (image mode) — txt2img + img2img/upscale/
  // inpaint/bg-removal/controlnet-pose. Custom-node workflows degrade with a clear
  // server-side "not installed" message. A non-txt2img workflow reuses the source picker.
  const WORKFLOW_OPTS: Array<[string, string]> = [
    ['', 'studio.wf.txt2img'], ['img2img', 'studio.wf.img2img'], ['upscale', 'studio.wf.upscale'],
    ['inpaint', 'studio.wf.inpaint'], ['bg-removal', 'studio.wf.bgRemoval'], ['controlnet-pose', 'studio.wf.controlnetPose'],
  ];
  const workflowSelect = h('select', { class: 'studio-wf-select' }, ...WORKFLOW_OPTS.map(([v, k]) => h('option', { value: v }, t(k)))) as HTMLSelectElement;
  const workflowGroup = h('div', { class: 'studio-chip-group' }, h('div', { class: 'studio-chip-label' }, t('studio.wf.label')), h('div', { class: 'studio-chips' }, workflowSelect));

  // LoRA dropdown (datalist; free-text + live names from /api/vault/comfy-loras) — txt2img only.
  const loraList = h('datalist', { id: 'studio-lora-list' });
  const loraInput = h('input', { type: 'text', class: 'studio-lora-input', list: 'studio-lora-list', placeholder: t('studio.wf.loraNone') }) as HTMLInputElement;
  loraInput.addEventListener('input', () => { loraName = loraInput.value.trim(); });
  const loraGroup = h('div', { class: 'studio-chip-group' }, h('div', { class: 'studio-chip-label' }, t('studio.wf.lora')), h('div', { class: 'studio-chips' }, loraInput, loraList));
  void api.get<{ reachable: boolean; loras: string[] }>('/api/vault/comfy-loras')
    .then((r) => mount(loraList, ...r.loras.map((n) => h('option', { value: n }))))
    .catch(() => undefined);

  const imageGroups = [faceGroup, workflowGroup, loraGroup];
  // workflow → source/lora visibility: a source-consuming workflow shows the picker in
  // image mode; LoRA only applies to the plain txt2img path.
  const SOURCE_WF = new Set(['img2img', 'upscale', 'inpaint', 'bg-removal', 'controlnet-pose']);
  const updateWorkflowUi = (): void => {
    loraGroup.classList.toggle('hidden', mode !== 'image' || workflow !== '');
    if (mode === 'image') sourceGroup.classList.toggle('hidden', !SOURCE_WF.has(workflow));
  };
  workflowSelect.addEventListener('change', () => { workflow = workflowSelect.value; updateWorkflowUi(); });

  // ---- mode toggle (in-place: never wipes the prompt) ----
  let imgBtn: HTMLButtonElement; let vidBtn: HTMLButtonElement;
  const setMode = (m: Mode): void => {
    if (mode !== m) { mode = m; if (qualityLevel) settings.steps = STEPS[mode][qualityLevel]; }
    imgBtn.classList.toggle('active', mode === 'image');
    vidBtn.classList.toggle('active', mode === 'video');
    for (const g of videoGroups) g.classList.toggle('hidden', mode === 'image');
    for (const g of imageGroups) g.classList.toggle('hidden', mode === 'video');
    updateFaceVisibility();
    updateWorkflowUi();
    syncChips();
  };
  imgBtn = h('button', { class: 'studio-mode-btn', onclick: () => setMode('image') }, pick('🖼 Kép', '🖼 Image')) as HTMLButtonElement;
  vidBtn = h('button', { class: 'studio-mode-btn', onclick: () => setMode('video') }, pick('🎬 Videó', '🎬 Video')) as HTMLButtonElement;

  // ---- fine-settings modal ----
  const openSettings = (): void => {
    const field = (labelKey: string, key: keyof typeof settings, attrs: Record<string, unknown>): { el: HTMLInputElement; node: HTMLElement } => {
      const el = h('input', { type: 'number', value: settings[key] !== undefined ? String(settings[key]) : '', ...attrs }) as HTMLInputElement;
      return { el, node: h('div', { class: 'field' }, h('label', null, t(labelKey)), el) };
    };
    const w = field('studio.fs.width', 'width', { min: 256, max: 2048, step: 8, placeholder: 'auto' });
    const ht = field('studio.fs.height', 'height', { min: 256, max: 2048, step: 8, placeholder: 'auto' });
    const st = field('studio.fs.steps', 'steps', { min: 1, max: 80, placeholder: 'auto' });
    const cfg = field('studio.fs.cfg', 'cfg', { min: 1, max: 20, step: 0.5, placeholder: 'auto' });
    const sec = field('studio.fs.seconds', 'seconds', { min: 1, max: 60, step: 0.5, placeholder: 'auto' });
    const seed = field('studio.fs.seed', 'seed', { min: 0, placeholder: pick('véletlen', 'random') });
    const neg = h('textarea', { rows: 2, placeholder: pick('pl. elmosódott, torz kéz, szöveg', 'e.g. blurry, distorted hands, text') }, settings.negative ?? '') as HTMLTextAreaElement;
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    const apply = (): void => {
      const set = (el: HTMLInputElement, key: keyof typeof settings): void => { const n = Number(el.value); if (el.value.trim() !== '' && Number.isFinite(n)) (settings[key] as number) = n; else delete settings[key]; };
      set(w.el, 'width'); set(ht.el, 'height'); set(st.el, 'steps'); set(cfg.el, 'cfg'); set(sec.el, 'seconds'); set(seed.el, 'seed');
      if (st.el.value.trim() !== '') qualityLevel = '';
      if (neg.value.trim() !== '') settings.negative = neg.value.trim(); else delete settings.negative;
      syncChips(); close();
    };
    const clearAll = (): void => { for (const k of Object.keys(settings)) delete (settings as Record<string, unknown>)[k]; qualityLevel = ''; customSec.value = ''; syncChips(); close(); };
    backdrop.append(h('div', { class: 'modal studio-settings-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t('studio.fs.title')), h('button', { class: 'icon-btn', onclick: close }, '✕')),
      h('div', { class: 'agent-modal-body' },
        h('div', { class: 'field-note' }, t('studio.fs.note')),
        h('div', { class: 'studio-fs-grid' }, w.node, ht.node, st.node, cfg.node, sec.node, seed.node),
        h('div', { class: 'field' }, h('label', null, t('studio.fs.negative')), neg),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'secondary', onclick: clearAll }, t('studio.fs.clearAll')),
          h('button', { class: 'secondary', onclick: close }, t('studio.fs.close')),
          h('button', { class: 'primary', onclick: apply }, t('studio.fs.apply')),
        ),
      ),
    ));
    document.body.append(backdrop); document.body.classList.add('modal-open');
  };

  // ---- results ----
  const renderResult = (job: Job): void => {
    mount(gallery, ...(job.files ?? []).map((f) => {
      const url = `/api/studio/media?path=${encodeURIComponent(f)}&token=${encodeURIComponent(getToken())}`;
      if (IMG_EXT.test(f)) return h('div', { class: 'studio-tile', onclick: () => openLightbox(url, f.split('/').pop() ?? '') }, h('img', { src: url, loading: 'lazy', alt: '' }));
      if (VID_EXT.test(f)) return h('div', { class: 'studio-tile' },
        h('video', { src: url, controls: true, loop: true }),
        h('a', { class: 'studio-tile-dl link-btn', href: url, download: f.split('/').pop() ?? 'video.mp4' }, icon('import', 14), t('studio.download')));
      return h('div', { class: 'studio-tile' });
    }));
    mount(logBody, ...(job.log ?? []).map((l) => h('div', { class: 'studio-log-line' }, l)), ...(job.reply ? [h('div', { class: 'studio-log-line reply' }, job.reply)] : []));
  };

  const openLightbox = (url: string, name: string): void => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.append(h('div', { class: 'modal studio-lightbox' },
      h('img', { src: url, alt: name }),
      h('div', { class: 'studio-lightbox-foot' }, h('span', null, name), h('a', { href: url, download: name, class: 'link-btn' }, t('studio.download'))),
    ));
    document.body.append(backdrop); document.body.classList.add('modal-open');
  };

  // ---- i2v source picker (FIX-studio-2 §1): choose a still from the generated images ----
  const openSourcePicker = (): void => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    const grid = h('div', { class: 'studio-source-grid' }, h('div', { class: 'muted-note' }, t('studio.source.loading')));
    backdrop.append(h('div', { class: 'modal studio-source-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t('studio.source.title')), h('button', { class: 'icon-btn', onclick: close }, '✕')),
      h('div', { class: 'agent-modal-body' }, h('div', { class: 'field-note' }, t('studio.source.help')), grid)));
    document.body.append(backdrop); document.body.classList.add('modal-open');
    void api.get<{ entries: Array<{ name: string; media: string }> }>('/api/files/list?root=images&path=')
      .then((r) => {
        const imgs = r.entries.filter((e) => e.media === 'image');
        if (imgs.length === 0) { mount(grid, h('div', { class: 'muted-note' }, t('studio.source.empty'))); return; }
        mount(grid, ...imgs.map((e) => h('button', { class: 'studio-source-tile', onclick: () => { sourceImage = e.name; sourceLabel = e.name; renderSource(); close(); } },
          h('img', { src: `/api/files/raw?root=images&path=${encodeURIComponent(e.name)}&token=${encodeURIComponent(getToken())}`, loading: 'lazy', alt: e.name }),
          h('span', { class: 'studio-source-name' }, e.name))));
      })
      .catch(() => mount(grid, h('div', { class: 'muted-note err' }, t('studio.source.error'))));
  };

  // ---- reference-face picker (FIX-studio-3): pick a face from generated images OR uploads ----
  const openFacePicker = (): void => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    const grid = h('div', { class: 'studio-source-grid' }, h('div', { class: 'muted-note' }, t('studio.source.loading')));
    let root = 'uploads'; // a reference photo usually lives in the uploads dir
    const imgBtnRoot = h('button', { class: 'chip' }, t('studio.face.rootImages')) as HTMLButtonElement;
    const upBtnRoot = h('button', { class: 'chip' }, t('studio.face.rootUploads')) as HTMLButtonElement;
    const loadRoot = (): void => {
      imgBtnRoot.classList.toggle('active', root === 'images');
      upBtnRoot.classList.toggle('active', root === 'uploads');
      mount(grid, h('div', { class: 'muted-note' }, t('studio.source.loading')));
      void api.get<{ entries: Array<{ name: string; media: string }> }>(`/api/files/list?root=${root}&path=`)
        .then((r) => {
          const imgs = r.entries.filter((e) => e.media === 'image');
          if (imgs.length === 0) { mount(grid, h('div', { class: 'muted-note' }, t('studio.face.empty'))); return; }
          mount(grid, ...imgs.map((e) => h('button', { class: 'studio-source-tile', onclick: () => { faceImage = e.name; faceLabel = e.name; renderFace(); close(); } },
            h('img', { src: `/api/files/raw?root=${root}&path=${encodeURIComponent(e.name)}&token=${encodeURIComponent(getToken())}`, loading: 'lazy', alt: e.name }),
            h('span', { class: 'studio-source-name' }, e.name))));
        })
        .catch(() => mount(grid, h('div', { class: 'muted-note err' }, t('studio.source.error'))));
    };
    imgBtnRoot.addEventListener('click', () => { root = 'images'; loadRoot(); });
    upBtnRoot.addEventListener('click', () => { root = 'uploads'; loadRoot(); });
    backdrop.append(h('div', { class: 'modal studio-source-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t('studio.face.title')), h('button', { class: 'icon-btn', onclick: close }, '✕')),
      h('div', { class: 'agent-modal-body' },
        h('div', { class: 'field-note' }, t('studio.face.help')),
        h('div', { class: 'studio-chips' }, upBtnRoot, imgBtnRoot),
        grid)));
    document.body.append(backdrop); document.body.classList.add('modal-open');
    loadRoot();
  };

  // ---- run + poll ----
  const setStatus = (text: string): void => { statusLine.style.display = 'block'; statusLine.textContent = text; };
  const pollJob = (jobId: string): void => {
    if (polling) return;
    polling = true;
    let misses = 0;
    const tick = async (): Promise<void> => {
      try {
        const job = await api.get<Job>(`/api/studio/job/${encodeURIComponent(jobId)}`);
        misses = 0;
        // §6.2 wall-clock cap: a job stuck running past ~45 min stops the UI poll
        // (it may still finish server-side → point at the Files page). Elapsed is
        // server-authoritative so a re-attached job caps on true age, not poll age.
        const tooLong = job.elapsed >= POLL_CAP_SECONDS;
        if (job.status === 'running') {
          if (tooLong) { polling = false; localStorage.removeItem(JOB_KEY); startBtn.disabled = false; setStatus(t('studio.tooLong')); return; }
          setStatus(t('studio.working', { progress: job.progress, secs: job.elapsed })); window.setTimeout(() => void tick(), 2500); return;
        }
        polling = false; localStorage.removeItem(JOB_KEY); startBtn.disabled = false;
        if (job.status === 'done') { setStatus(job.reply || t('studio.done')); renderResult(job); }
        else setStatus(tooLong ? t('studio.tooLong') : t('studio.error', { msg: job.error ?? '' }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) { polling = false; localStorage.removeItem(JOB_KEY); startBtn.disabled = false; setStatus(t('studio.jobLost')); return; }
        misses += 1;
        if (misses > 40) { polling = false; localStorage.removeItem(JOB_KEY); startBtn.disabled = false; setStatus(t('studio.connLost')); return; }
        window.setTimeout(() => void tick(), 2500);
      }
    };
    void tick();
  };

  const start = async (): Promise<void> => {
    const request = textarea.value.trim();
    if (request === '') return;
    startBtn.disabled = true; setStatus(t('studio.starting')); mount(gallery); mount(logBody);
    try {
      const payload: Record<string, unknown> = { request, settings, mode };
      if (mode === 'video') { payload.model = videoModel; if (sourceImage !== '') payload.sourceImage = sourceImage; }
      else if (workflow !== '') { // workflow pack (FIX-plugin-comfy-workflows)
        payload.workflow = workflow;
        if (workflow === 'controlnet-pose') payload.poseImage = sourceImage;
        else if (sourceImage !== '') payload.sourceImage = sourceImage;
      }
      else if (faceImage !== '') { payload.referenceImage = faceImage; payload.weight = faceWeight; } // InstantID face (FIX-studio-3)
      else if (loraName !== '') { (settings as Record<string, unknown>).lora = loraName; } // LoRA on the txt2img path
      const r = await api.post<{ jobId: string }>('/api/studio/run', payload);
      localStorage.setItem(JOB_KEY, r.jobId);
      pollJob(r.jobId);
    } catch (err) {
      startBtn.disabled = false;
      if (err instanceof ApiError && err.status === 409) setStatus(err.message);
      else setStatus(t('studio.error', { msg: err instanceof ApiError ? err.message : String(err) }));
    }
  };
  startBtn.addEventListener('click', () => void start());
  textarea.addEventListener('keydown', (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void start(); } });

  // ---- comfy indicator (§6.10): live reachability + awake detail + a waking flow ----
  interface ComfyStatus { state: string; text: string; wakeable: boolean; version?: string; device?: string; models?: number; checkpoint?: string }
  const comfyRow = h('div', { class: 'studio-comfy' });
  let comfyWaking = false;
  let comfyWakeAttempts = 0;

  // Compose the RUNNING line with optional version / device / model-count (§4/§10).
  function comfyRunningLabel(cs: ComfyStatus): string {
    const detail = [
      cs.version ? `(${cs.version})` : '',
      cs.device ?? '',
      cs.models !== undefined ? t('studio.comfy.models', { n: cs.models }) : '',
      cs.checkpoint ? t('studio.comfy.checkpoint', { name: cs.checkpoint }) : '',
    ].filter((s) => s !== '');
    return detail.length > 0 ? `${t('studio.comfy.running')} ${detail.join(' · ')}` : t('studio.comfy.running');
  }
  function renderComfy(cs: ComfyStatus): void {
    // dot: awake = on; unknown/unconfigured = muted; stopped/asleep = failed
    const dot = cs.state === 'awake' ? 'dot-connected'
      : (cs.state === 'unknown' || cs.state === 'unconfigured') ? 'dot-unknown'
      : 'dot-failed';
    // asleep is a backend variant of "stopped" for display purposes (spec vocab: stopped)
    const label = cs.state === 'awake' ? comfyRunningLabel(cs)
      : cs.state === 'unconfigured' ? t('studio.comfy.unconfigured')
      : cs.state === 'unknown' ? t('studio.comfy.unknown')
      : t('studio.comfy.stopped');
    const els: HTMLElement[] = [h('span', { class: `conn-dot ${dot}` }), h('span', { class: 'comfy-text' }, label)];
    if (cs.wakeable && cs.state !== 'awake') els.push(h('button', { class: 'btn-mini', onclick: () => startWake() }, t('studio.comfy.wake')));
    mount(comfyRow, ...els);
  }
  function renderWaking(): void {
    mount(comfyRow, h('span', { class: 'conn-dot dot-degraded' }), h('span', { class: 'comfy-text' }, t('studio.comfy.waking')));
  }
  function wakeTick(): void {
    window.setTimeout(() => {
      if (!comfyRow.isConnected) { comfyWaking = false; return; }
      void api.get<ComfyStatus>('/api/vault/comfy-status').then((cs) => {
        if (cs.state === 'awake') { comfyWaking = false; renderComfy(cs); return; }
        comfyWakeAttempts += 1;
        if (comfyWakeAttempts >= WAKE_MAX_ATTEMPTS) { comfyWaking = false; renderComfy(cs); return; } // gave up — show the real state
        renderWaking(); wakeTick();
      }).catch(() => { comfyWaking = false; pollComfy(); });
    }, WAKE_INTERVAL_MS);
  }
  function startWake(): void {
    if (comfyWaking) return;
    comfyWaking = true; comfyWakeAttempts = 0;
    renderWaking();
    void api.post('/api/vault/comfy-wake').catch(() => undefined);
    wakeTick();
  }
  function pollComfy(): void {
    if (comfyWaking) return; // don't let the 20s poll stomp the waking display
    void api.get<ComfyStatus>('/api/vault/comfy-status').then(renderComfy).catch(() => undefined);
  }

  mount(host,
    h('div', { class: 'page-header' }, h('h1', null, t('studio.title')), h('p', { class: 'subtitle' }, t('studio.subtitle'))),
    h('div', { class: 'panel studio-composer' },
      h('div', { class: 'studio-mode' }, imgBtn, vidBtn),
      textarea,
      chipGroup('studio.group.style', styleChips),
      faceGroup,
      workflowGroup,
      loraGroup,
      weightRow,
      modelGroup,
      motionGroup,
      chipGroup('studio.group.size', sizeChips),
      chipGroup('studio.group.quality', qualityChips),
      lengthGroup,
      sourceGroup,
      h('div', { class: 'studio-run-row' },
        h('button', { class: 'secondary', title: pick('Finom beállítások (felülírja a preseteket)', 'Fine settings (override the presets)'), onclick: openSettings }, icon('gear', 16), t('studio.settings')),
        startBtn,
      ),
      comfyRow,
    ),
    statusLine,
    gallery,
    h('details', { class: 'studio-log' }, h('summary', null, t('studio.details')), logBody),
  );
  setMode(mode); // sets the active mode button + video-group visibility + chip sync
  pollComfy();
  const comfyTimer = window.setInterval(() => { if (comfyRow.isConnected) pollComfy(); else clearInterval(comfyTimer); }, 20_000);
  // resume a job that was in flight before a refresh
  const saved = localStorage.getItem(JOB_KEY);
  if (saved) void api.get<Job>(`/api/studio/job/${encodeURIComponent(saved)}`).then((j) => { if (j.status === 'running') { startBtn.disabled = true; pollJob(saved); } else { localStorage.removeItem(JOB_KEY); } }).catch(() => localStorage.removeItem(JOB_KEY));
}

defineView('studio', 'nav.studio', (host, store) => { void render(host, store); });
