// Petits outils d'interface : création d'éléments, dialogues, feuilles, snackbar, dates, images.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

// Remplace le contenu d'un élément en ignorant null/false (replaceChildren écrirait « null »).
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// Ajoute des enfants en ignorant null/false et en aplatissant les listes.
export function add(el, ...children) {
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const icon = (name, cls = '') => h('span', { class: ('msi ' + cls).trim(), 'aria-hidden': 'true' }, name);

export function button(label, { kind = 'filled', ic, onclick, cls = '', type = 'button', disabled, title } = {}) {
  return h('button', { class: `btn btn-${kind} ${cls}`.trim(), type, onclick, disabled, title, 'aria-label': title || null },
    ic ? icon(ic) : null, label ? h('span', {}, label) : null);
}

export function iconButton(ic, title, onclick, cls = '') {
  return h('button', { class: ('icon-btn ' + cls).trim(), type: 'button', title, 'aria-label': title, onclick }, icon(ic));
}

export function loader(label) {
  return h('div', { class: 'loader-wrap', role: 'status' }, h('div', { class: 'loader' }), label ? h('p', { class: 'muted' }, label) : null);
}

/* ---------- Snackbar ---------- */
let snackTimer;
export function snackbar(message, { action, onAction, duration = 4000 } = {}) {
  const bar = document.getElementById('snackbar');
  fill(bar, h('span', {}, message),
    action ? h('button', { class: 'snack-action', type: 'button', onclick: () => { hide(); onAction?.(); } }, action) : null);
  bar.classList.add('show');
  clearTimeout(snackTimer);
  const hide = () => bar.classList.remove('show');
  snackTimer = setTimeout(hide, duration);
}

/* ---------- Surcouches (dialogue plein écran, feuille, petite boîte) ---------- */
const stack = [];
let ignorePops = 0;
window.addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  const top = stack[stack.length - 1];
  if (top) top.close(true);
});

function mountLayer(el, onClose) {
  const root = document.getElementById('overlay');
  root.append(el);
  requestAnimationFrame(() => el.classList.add('open'));
  const layer = {
    el,
    guard: null,   // fonction async facultative : renvoie false pour empêcher la fermeture
    close(fromHistory = false, force = false) {
      const i = stack.indexOf(layer);
      if (i < 0) return;
      if (layer.guard && !force) {
        // Retour Android : on remet tout de suite l'entrée d'historique, puis on traite comme la croix.
        if (fromHistory) history.pushState({ layer: stack.length }, '');
        if (layer.checking) return;
        layer.checking = true;
        Promise.resolve(layer.guard()).then(ok => {
          layer.checking = false;
          if (ok) layer.close(false, true);
        });
        return;
      }
      stack.splice(i, 1);
      el.classList.remove('open');
      el.classList.add('closing');
      setTimeout(() => el.remove(), 260);
      onClose?.();
      if (!fromHistory) { ignorePops++; history.back(); }
    },
  };
  stack.push(layer);
  history.pushState({ layer: stack.length }, '');
  return layer;
}

export function fullDialog({ title, body, actions = [], onClose }) {
  let layer;
  const el = h('div', { class: 'fulldialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'fd-head' },
      iconButton('close', 'Fermer', () => layer.close()),
      h('h2', {}, title),
      h('div', { class: 'fd-actions' }, actions)),
    h('div', { class: 'fd-body' }, body));
  layer = mountLayer(el, onClose);
  return layer;
}

// Visionneuse plein écran : photos une par une (glisser ou flèches), fermeture par la croix ou le retour Android.
export function photoViewer(urls, start = 0, { title = '', onClose } = {}) {
  if (!urls.length) return null;
  let layer, idx = Math.min(Math.max(start, 0), urls.length - 1);
  const counter = h('span', { class: 'pv-count' });
  const track = h('div', { class: 'pv-track' },
    urls.map((u, i) => h('div', { class: 'pv-slide' }, h('img', { src: u, alt: `Photo ${i + 1}`, draggable: 'false' }))));
  const prev = iconButton('chevron_left', 'Photo précédente', () => go(idx - 1), 'pv-nav pv-prev');
  const next = iconButton('chevron_right', 'Photo suivante', () => go(idx + 1), 'pv-nav pv-next');
  const paint = () => {
    counter.textContent = `${idx + 1} / ${urls.length}`;
    prev.disabled = idx === 0; next.disabled = idx === urls.length - 1;
  };
  function go(i, smooth = true) {
    idx = Math.min(Math.max(i, 0), urls.length - 1);
    track.scrollTo({ left: idx * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    paint();
  }
  let raf;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); if (i !== idx) { idx = i; paint(); } });
  });
  const onKey = (e) => { if (e.key === 'ArrowLeft') go(idx - 1); if (e.key === 'ArrowRight') go(idx + 1); };
  document.addEventListener('keydown', onKey);
  const el = h('div', { class: 'photoviewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photos' },
    h('header', { class: 'pv-head' }, iconButton('close', 'Fermer', () => layer.close()),
      h('div', { class: 'pv-titles' }, title ? h('strong', { class: 'pv-title' }, title) : null, counter)),
    track, urls.length > 1 ? prev : null, urls.length > 1 ? next : null);
  layer = mountLayer(el, () => { document.removeEventListener('keydown', onKey); onClose?.(); });
  paint();
  requestAnimationFrame(() => go(idx, false));
  return layer;
}

export function sheet({ title, body, onClose }) {
  let layer;
  const el = h('div', { class: 'sheet-root' },
    h('div', { class: 'scrim', onclick: () => layer.close() }),
    h('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'handle' }), title ? h('h2', { class: 'sheet-title' }, title) : null, h('div', { class: 'sheet-body' }, body)));
  layer = mountLayer(el, onClose);
  return layer;
}

export function confirmBox(message, { ok = 'Confirmer', danger = false } = {}) {
  return new Promise(resolve => {
    let layer, answered = false;
    const done = (v) => { answered = true; resolve(v); layer.close(); };
    const el = h('div', { class: 'sheet-root center' },
      h('div', { class: 'scrim', onclick: () => done(false) }),
      h('section', { class: 'alert', role: 'alertdialog', 'aria-modal': 'true' },
        h('p', {}, message),
        h('div', { class: 'row end' },
          button('Annuler', { kind: 'text', onclick: () => done(false) }),
          button(ok, { kind: danger ? 'danger' : 'filled', onclick: () => done(true) }))));
    layer = mountLayer(el, () => { if (!answered) resolve(false); });
  });
}

export function promptBox(message, { value = '', type = 'text', ok = 'Valider', suffix = '' } = {}) {
  return new Promise(resolve => {
    let layer, answered = false;
    const input = h('input', { type, value, inputmode: type === 'number' ? 'decimal' : null });
    const done = (v) => { answered = true; resolve(v); layer.close(); };
    const el = h('div', { class: 'sheet-root center' },
      h('div', { class: 'scrim', onclick: () => done(null) }),
      h('section', { class: 'alert', role: 'dialog', 'aria-modal': 'true' },
        h('label', { class: 'field' }, h('span', {}, message), h('div', { class: 'with-suffix' }, input, suffix ? h('em', {}, suffix) : null)),
        h('div', { class: 'row end' },
          button('Annuler', { kind: 'text', onclick: () => done(null) }),
          button(ok, { onclick: () => done(input.value) }))));
    layer = mountLayer(el, () => { if (!answered) resolve(null); });
    setTimeout(() => input.focus(), 50);
  });
}

/* ---------- Dates (heure locale) ---------- */
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fromIso = (s) => new Date(s + 'T12:00:00');
export const addDays = (iso, n) => { const d = fromIso(iso); d.setDate(d.getDate() + n); return isoDate(d); };
export const mondayOf = (iso) => { const d = fromIso(iso); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return isoDate(d); };
export const today = () => isoDate(new Date());
export const fmtDay = (iso, opts = { weekday: 'long', day: 'numeric', month: 'long' }) =>
  fromIso(iso).toLocaleDateString('fr-FR', opts);

/* ---------- Images ---------- */
async function toBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}

function draw(src, max) {
  const w = src.width, hgt = src.height;
  const s = Math.min(1, max / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(hgt * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export async function processImage(file) {
  const bmp = await toBitmap(file);
  const big = draw(bmp, 1280);
  const blob = await new Promise(r => big.toBlob(r, 'image/jpeg', 0.85));
  const thumb = draw(bmp, 400).toDataURL('image/jpeg', 0.78);
  bmp.close?.();
  if (!blob) throw new Error('Image illisible');
  return { blob, thumb };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  snackbar('Copié');
}

export const debounce = (fn, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
