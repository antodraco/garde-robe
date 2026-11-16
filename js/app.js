import { db, nextItemId } from './db.js';
import {
  CATEGORIES, GROUPS, GROUP_ORDER, groupOf, MEASURES, ETATS, SAISONS, STATUTS, FORMALITE, CHALEUR,
  PROFILE_MEASURES, PROFILE_SIZES, PROFILE_TASTES,
} from './data.js';
import { fetchWeather, describe, geocode } from './weather.js';
import {
  AIError, DEFAULT_MODEL, MODELS, analyseItem, generateOutfits, triWardrobe, makeListing, callGemini, dayName,
  wardrobeContext, chatReply, chatTurn, recommendPurchases, stripIds,
} from './ai.js';
import * as drive from './drive.js';
import {
  h, icon, button, iconButton, loader, snackbar, fullDialog, sheet, confirmBox, promptBox, photoViewer,
  isoDate, addDays, mondayOf, today, fmtDay, processImage, copyText, debounce, fill, add,
} from './ui.js';
import { applyTheme as applyDynamicTheme, seedsFromImage, DEFAULT_SEED, PRESETS } from './theme.js';

const DEFAULT_SETTINGS = {
  apiKey: '', model: DEFAULT_MODEL, theme: 'auto', searchPrices: true, seedColor: DEFAULT_SEED, wallpaperSeeds: [],
  autoWeek: true, driveClientId: '', driveAuto: true,
  lieu: { name: 'Paris', detail: 'Île-de-France, France', lat: 48.8566, lon: 2.3522 },
};

const DEFAULT_FILTER = { group: 'all', statut: 'garde', q: '' };
const loadFilter = () => { try { return { ...DEFAULT_FILTER, ...JSON.parse(sessionStorage.getItem('gr-filter') || '{}') }; } catch { return { ...DEFAULT_FILTER }; } };
const saveFilter = () => { try { sessionStorage.setItem('gr-filter', JSON.stringify(state.filter)); } catch { /* stockage indisponible */ } };
const state = {
  items: [], profile: {}, settings: { ...DEFAULT_SETTINGS }, tri: null, wishlist: [],
  filter: loadFilter(),
  weekStart: null, busy: false,
};
const byId = () => Object.fromEntries(state.items.map(i => [i.id, i]));
// Textes de l'IA : un identifiant isolé dans une phrase (« avec v12 et v31 ») devient le nom de la pièce ;
// les identifiants entre parenthèses, redondants avec le nom déjà écrit, sont simplement retirés.
function cleanAI(t) {
  const items = byId();
  const named = String(t ?? '').replace(/(^|[\s,;:])(v\d+)\b(?!\s*\))/g, (m, pre, id) =>
    items[id] ? `${pre}« ${items[id].nom.charAt(0).toLowerCase() + items[id].nom.slice(1)} »` : m);
  return stripIds(named);
}
const view = () => document.getElementById('view');

/* =========================================================== Démarrage */
async function init() {
  const [items, profile, settings, tri, wishlist] = await Promise.all([
    db.all('items'), db.getKV('profile'), db.getKV('settings'), db.getKV('tri'), db.getKV('wishlist'),
  ]);
  state.wishlist = wishlist || [];
  state.wishlistBilan = (await db.getKV('wishlistBilan')) || '';
  state.items = items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  state.profile = profile || {};
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.tri = tri || null;
  applyTheme();
  const t = today();
  // Le week-end, on prépare déjà la semaine suivante.
  state.weekStart = [0, 6].includes(new Date().getDay()) ? addDays(mondayOf(t), 7) : mondayOf(t);

  // Changer d'onglet conserve tout (recherche, filtres, défilement) ;
  // un 2e appui sur l'onglet déjà ouvert le remet à zéro.
  document.querySelectorAll('#navbar [data-route]').forEach(b =>
    b.addEventListener('click', () => {
      if (b.dataset.route === currentRoute) resetRoute(currentRoute);
      else location.hash = '#/' + b.dataset.route;
    }));
  if (new URLSearchParams(location.search).has('shared')) history.replaceState(null, '', location.pathname + '#/styliste');
  window.addEventListener('hashchange', route);
  route();
  scanInbox();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scanInbox(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

function applyTheme() {
  try { applyDynamicTheme(state.settings.seedColor, state.settings.theme); }
  catch {
    const t = state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
}

const saveSettings = () => db.setKV('settings', state.settings);
const saveProfile = debounce(() => db.setKV('profile', state.profile), 300);

async function saveItem(item) {
  item.updatedAt = new Date().toISOString();
  await db.put('items', item);
  const i = state.items.findIndex(x => x.id === item.id);
  if (i >= 0) state.items[i] = item; else state.items.unshift(item);
  scheduleAutoBackup();
}
const saveWishlist = () => { scheduleAutoBackup(); return db.setKV('wishlist', state.wishlist); };
const saveWeek = (week) => { scheduleAutoBackup(); return db.put('weeks', week); };

const ROUTES = {
  tenues: { title: 'Tenues', render: renderTenues },
  'garde-robe': { title: 'Garde-robe', render: renderWardrobe },
  styliste: { title: 'Styliste', render: renderStyliste },
  tri: { title: 'Tri & achats', render: renderTri },
  profil: { title: 'Profil', render: renderProfil },
};

let currentRoute = null;
const scrollPos = {};
function resetRoute(r) {
  if (r === 'garde-robe') { state.filter = { ...DEFAULT_FILTER }; saveFilter(); }
  scrollPos[r] = 0;
  route();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function route() {
  const [name, query] = location.hash.replace(/^#\//, '').split('?');
  const r = ROUTES[name] ? name : 'tenues';
  if (currentRoute && currentRoute !== r) scrollPos[currentRoute] = window.scrollY;
  const keepScroll = currentRoute !== r ? (scrollPos[r] || 0) : 0;
  currentRoute = r;
  document.querySelectorAll('#navbar [data-route]').forEach(b => {
    const on = b.dataset.route === r;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.getElementById('title').textContent = ROUTES[r].title;
  document.getElementById('topActions').replaceChildren();
  view().replaceChildren();
  view().dataset.route = r;
  window.scrollTo(0, 0);
  ROUTES[r].render();
  if (keepScroll) requestAnimationFrame(() => window.scrollTo(0, keepScroll));
  if (r === 'garde-robe' && query === 'add=1') { history.replaceState(null, '', '#/garde-robe'); openItemEditor(null); }
  if (r === 'styliste' && query?.startsWith('shared=')) { history.replaceState(null, '', '#/styliste'); loadSharedInbox(query.slice(7)); }
}
const rerender = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };

function needKeyCard() {
  return h('section', { class: 'card tonal' },
    h('h3', {}, icon('key'), ' Clé Gemini nécessaire'),
    h('p', {}, 'L’IA a besoin de ta clé API Google AI Studio (gratuite). Elle reste uniquement sur ton téléphone.'),
    button('Ajouter ma clé', { ic: 'arrow_forward', onclick: () => { location.hash = '#/profil'; } }));
}

function errorText(e) {
  return e instanceof AIError ? e.message : ('Erreur : ' + (e?.message || e));
}

/* =========================================================== Vignettes */
function thumb(item, cls = '') {
  if (item?.thumb) return h('img', { class: 'thumb ' + cls, src: item.thumb, alt: item.nom || '', loading: 'lazy' });
  return h('div', { class: 'thumb placeholder ' + cls }, icon(GROUPS[groupOf(item?.categorie)]?.icon || 'checkroom'));
}

// Toutes les photos d'une pièce en plein écran (défilement une par une).
async function openItemPhotos(item, start = 0) {
  const urls = [];
  for (const pid of item?.photoIds || []) {
    const p = await db.get('photos', pid);
    if (p?.blob) urls.push(URL.createObjectURL(p.blob));
  }
  if (!urls.length && item?.thumb) urls.push(item.thumb);
  if (!urls.length) { snackbar('Pas de photo pour cette pièce.'); return; }
  photoViewer(urls, start, { title: item.nom || item.categorie, onClose: () => urls.forEach(u => u.startsWith('blob:') && URL.revokeObjectURL(u)) });
}
// Vignette qu'on touche pour voir la pièce en grand (sans déclencher l'action de la ligne).
function zoomThumb(item, cls = '') {
  return h('span', { class: 'zoom-thumb', role: 'button', tabindex: '0', 'aria-label': `Voir ${item?.nom || 'la pièce'} en grand`,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); openItemPhotos(item); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); openItemPhotos(item); } } },
    thumb(item, cls), item?.thumb ? icon('zoom_in', 'zoom-badge') : null);
}

/* =========================================================== TENUES */
// La semaine se découpe en 1 ou 2 tenues de semaine (portées plusieurs jours) + éventuellement une tenue de week-end.
const DEFAULT_PLAN = { count: 2, split: 3, weekend: false };
const plan = () => ({ ...DEFAULT_PLAN, ...(state.settings.weekPlan || {}) });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function slotsFor(ws) {
  const p = plan();
  const d = (i) => addDays(ws, i);
  const range = (from, n) => Array.from({ length: n }, (_, i) => d(from + i));
  const slots = p.count === 1
    ? [{ key: 'A', dates: range(0, 5) }]
    : [{ key: 'A', dates: range(0, p.split) }, { key: 'B', dates: range(p.split, 5 - p.split) }];
  if (p.weekend) slots.push({ key: 'WE', dates: range(5, 2) });
  return slots.map(s => ({ ...s, label: slotLabel(s) }));
}

function slotLabel(s) {
  const a = s.dates[0], b = s.dates[s.dates.length - 1];
  if (s.key === 'WE') return 'Week-end';
  return s.dates.length === 1 ? cap(dayName(a)) : `${cap(dayName(a))} → ${dayName(b)}`;
}

const dateRange = (dates) => {
  const a = dates[0], b = dates[dates.length - 1];
  const f = (iso, o) => fmtDay(iso, o);
  if (a === b) return f(a, { day: 'numeric', month: 'long' });
  return a.slice(0, 7) === b.slice(0, 7)
    ? `${f(a, { day: 'numeric' })} – ${f(b, { day: 'numeric', month: 'long' })}`
    : `${f(a, { day: 'numeric', month: 'short' })} – ${f(b, { day: 'numeric', month: 'short' })}`;
};

function aggWeather(dates, weather) {
  const ws = dates.map(d => weather?.[d]).filter(Boolean);
  if (!ws.length) return null;
  const nums = (k) => ws.map(w => w[k]).filter(v => v != null);
  return {
    code: Math.max(...nums('code'), 0),
    tmin: Math.min(...nums('tmin')), tmax: Math.max(...nums('tmax')),
    pluieProba: Math.max(...nums('pluieProba'), 0),
  };
}

function normalizeWeek(week) {
  week.tenues ||= [];
  week.sac ||= [];
  return week;
}

async function renderTenues() {
  const v = view();
  const ws = state.weekStart;
  const t = today();
  const label = `${fmtDay(ws, { day: 'numeric', month: 'short' })} → ${fmtDay(addDays(ws, 6), { day: 'numeric', month: 'short' })}`;
  const week = normalizeWeek((await db.get('weeks', ws)) || { weekStart: ws, note: '' });
  const kept = state.items.filter(i => i.statut === 'garde');
  const slots = slotsFor(ws);
  const p = plan();

  v.append(h('div', { class: 'week-nav' },
    iconButton('chevron_left', 'Semaine précédente', () => { state.weekStart = addDays(ws, -7); rerender(); }),
    h('div', { class: 'week-label' },
      h('strong', {}, ws === mondayOf(t) ? 'Cette semaine' : ws === addDays(mondayOf(t), 7) ? 'Semaine prochaine' : 'Semaine'),
      h('span', {}, label)),
    iconButton('chevron_right', 'Semaine suivante', () => { state.weekStart = addDays(ws, 7); rerender(); })));

  if (!state.settings.apiKey) v.append(needKeyCard());
  if (kept.length < 4) {
    v.append(h('section', { class: 'card' },
      h('h3', {}, icon('checkroom'), ' Commence par ta garde-robe'),
      h('p', {}, `Ajoute au moins un haut, un bas et une paire de chaussures (${kept.length} pièce${kept.length > 1 ? 's' : ''} pour l’instant). Plus il y a de pièces, plus les tenues seront variées.`),
      button('Ajouter des vêtements', { ic: 'add_a_photo', onclick: () => { location.hash = '#/garde-robe?add=1'; } })));
  }

  // Organisation de la semaine
  const setPlan = (patch) => { state.settings.weekPlan = { ...p, ...patch }; saveSettings(); rerender(); };
  const seg = (options, current, onPick) => h('div', { class: 'segmented' }, options.map(([k, l]) =>
    h('button', { type: 'button', class: current === k ? 'on' : '', onclick: () => onPick(k) }, current === k ? icon('check') : null, l)));
  const weToggle = h('input', { type: 'checkbox', checked: p.weekend, onchange: () => setPlan({ weekend: weToggle.checked }) });
  const autoToggle = h('input', { type: 'checkbox', checked: state.settings.autoWeek, onchange: () => { state.settings.autoWeek = autoToggle.checked; saveSettings(); } });
  const toGenerate = slots.filter(s => s.dates[s.dates.length - 1] >= t);
  const note = h('textarea', { rows: 2, placeholder: 'Ex. oral jeudi, messe dimanche…', oninput: debounce(async () => {
    week.note = note.value; await saveWeek(week);
  }, 400) });
  note.value = week.note || '';
  const already = toGenerate.some(s => week.tenues.find(x => x.key === s.key && x.dates.join() === s.dates.join()));
  v.append(h('section', { class: 'card gen-card' },
    h('h3', {}, icon('event_repeat'), ' Ma semaine'),
    seg([[1, '1 tenue'], [2, '2 tenues']], p.count, (k) => setPlan({ count: k })),
    p.count === 2 ? seg([[2, 'Lun–mar · mer–ven'], [3, 'Lun–mer · jeu–ven']], p.split, (k) => setPlan({ split: k })) : null,
    h('label', { class: 'switch-row' }, weToggle, h('span', {}, 'Ajouter une tenue pour le week-end')),
    h('label', { class: 'switch-row' }, autoToggle, h('span', {}, 'Le week-end, préparer la semaine suivante automatiquement à l’ouverture')),
    h('label', { class: 'field' }, h('span', {}, 'Remarques pour la semaine (facultatif)'), note),
    button(already ? 'Proposer d’autres tenues' : 'Composer ma semaine', {
      ic: 'auto_awesome', cls: 'wide', disabled: !toGenerate.length || !state.settings.apiKey || kept.length < 2,
      onclick: () => runGeneration(week, toGenerate.map(s => s.key)),
    }),
    !toGenerate.length ? h('p', { class: 'muted small' }, 'Cette semaine est passée.') : null));

  const list = h('div', { class: 'days' });
  const bag = h('div', {});
  v.append(list, bag);
  const lieu = state.settings.lieu;
  v.append(h('p', { class: 'muted small center' }, icon('location_on', 'tiny'), ` Météo : ${lieu.name} · Open-Meteo`));

  let weather = state._weather || {};
  const paint = () => {
    list.replaceChildren(...slots.map(s => tenueCard(s, week.tenues.find(x => x.key === s.key && x.dates.join() === s.dates.join()), aggWeather(s.dates, weather), week)));
    fill(bag, bagCard(week, slots));
  };
  paint();
  try { weather = await fetchWeather(lieu.lat, lieu.lon); state._weather = weather; paint(); } catch { /* hors ligne : pas de météo */ }
  // Le week-end : la semaine suivante se prépare toute seule à l'ouverture (une fois par semaine).
  const isWeekend = [0, 6].includes(new Date().getDay());
  const nothingYet = !week.tenues.some(x => slots.some(s => s.key === x.key && s.dates.join() === x.dates.join()));
  if (isWeekend && state.settings.autoWeek && nothingYet && ws === addDays(mondayOf(t), 7) && state.settings.apiKey && kept.length >= 4 && !state.busy
      && state.settings.lastAutoWeek !== ws) {
    state.settings.lastAutoWeek = ws; saveSettings();
    snackbar('Le styliste prépare ta semaine prochaine…');
    runGeneration(week, toGenerate.map(s => s.key));
  }
}

function weatherChip(w) {
  if (!w) return h('span', { class: 'wchip muted' }, icon('cloud_off'), '—');
  const [lbl, ic] = describe(w.code);
  return h('span', { class: 'wchip', title: lbl }, icon(ic),
    `${Math.round(w.tmin)}° / ${Math.round(w.tmax)}°`,
    w.pluieProba >= 30 ? h('em', {}, ` · ${w.pluieProba} %`) : null);
}

function tenueCard(slot, tenue, w, week) {
  const t = today();
  const dates = tenue?.dates || slot.dates;
  const current = dates.includes(t);
  const past = dates[dates.length - 1] < t;
  const items = byId();
  const card = h('article', { class: 'day-card' + (current ? ' is-today' : '') + (past ? ' is-past' : '') },
    h('header', {},
      h('div', {}, h('h3', {}, slot.label), h('span', { class: 'muted' }, dateRange(dates) + (dates.length > 1 ? ` · ${dates.length} jours` : ''))),
      weatherChip(w)));
  if (!tenue) {
    card.append(h('p', { class: 'muted empty-day' }, past ? 'Aucune tenue enregistrée.' : 'Pas encore de tenue.'));
    return card;
  }
  card.append(h('h4', { class: 'outfit-title' }, cleanAI(tenue.titre)));
  const row = h('div', { class: 'outfit-items' });
  for (const id of tenue.itemIds) {
    const it = items[id];
    if (!it) continue;
    row.append(h('div', { class: 'outfit-piece' },
      h('button', { class: 'piece-swap', type: 'button', title: 'Changer cette pièce', 'aria-label': `Changer ${it.nom}`, onclick: () => swapPiece(week, tenue, id, w) }, icon('swap_horiz')),
      h('button', { class: 'piece-photo', type: 'button', title: 'Voir en grand', 'aria-label': `Voir ${it.nom} en grand`, onclick: () => openItemPhotos(it) }, thumb(it)),
      h('button', { class: 'piece-name', type: 'button', title: 'Changer cette pièce', onclick: () => swapPiece(week, tenue, id, w) }, h('span', {}, it.nom))));
  }
  card.append(row);
  if (tenue.explication) card.append(h('p', { class: 'explain' }, cleanAI(tenue.explication)));
  card.append(h('div', { class: 'row wrap' },
    button(tenue.porte ? 'Portée' : 'Je l’ai portée', { kind: tenue.porte ? 'tonal' : 'outlined', ic: tenue.porte ? 'check_circle' : 'radio_button_unchecked',
      onclick: () => toggleWorn(week, tenue) }),
    past ? null : button('Modifier avec l’IA', { kind: 'tonal', ic: 'edit_note', onclick: () => editWithAI(week, slot, tenue) }),
    past ? null : button('Autre tenue', { kind: 'text', ic: 'autorenew', onclick: () => runGeneration(week, [slot.key]) }),
    button('Agenda', { kind: 'text', ic: 'event', onclick: () => window.open(calendarUrl(tenue), '_blank', 'noopener') })));
  return card;
}

// Liste à cocher des pièces à emporter (tenues de semaine à venir).
function bagCard(week, slots) {
  const t = today();
  const upcoming = week.tenues.filter(x => x.key !== 'WE' && x.dates[x.dates.length - 1] >= t && slots.some(s => s.key === x.key && s.dates.join() === x.dates.join()));
  if (!upcoming.length) return null;
  const items = byId();
  const ids = [...new Set(upcoming.flatMap(x => x.itemIds))].filter(id => items[id])
    .sort((a, b) => GROUP_ORDER.indexOf(groupOf(items[a].categorie)) - GROUP_ORDER.indexOf(groupOf(items[b].categorie)));
  const packed = new Set(week.sac);
  const count = h('span', { class: 'muted small' }, `${ids.filter(id => packed.has(id)).length}/${ids.length}`);
  return h('section', { class: 'card' },
    h('h3', {}, icon('luggage'), ` Dans le sac pour ${state.settings.lieu?.name || 'la semaine'} `, count),
    h('p', { class: 'muted small' }, 'Les pièces des tenues de la semaine, à cocher en faisant ton sac.'),
    h('ul', { class: 'checklist bag' }, ids.map(id => {
      const cb = h('input', { type: 'checkbox', checked: packed.has(id), onchange: async () => {
        if (cb.checked) packed.add(id); else packed.delete(id);
        week.sac = [...packed]; await saveWeek(week);
        count.textContent = `${ids.filter(x => packed.has(x)).length}/${ids.length}`;
      } });
      return h('li', {}, h('label', {}, cb, zoomThumb(items[id], 'tiny'), h('span', {}, items[id].nom)));
    })));
}

function calendarUrl(tenue) {
  const items = byId();
  const pieces = tenue.itemIds.map(id => items[id]).filter(Boolean).map(i => '• ' + i.nom).join('\n');
  const details = pieces + (tenue.explication ? '\n\n' + tenue.explication : '');
  const d1 = tenue.dates[0].replaceAll('-', '');
  const d2 = addDays(tenue.dates[tenue.dates.length - 1], 1).replaceAll('-', '');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent('Tenue : ' + tenue.titre) + '&dates=' + d1 + '/' + d2 + '&details=' + encodeURIComponent(details);
}

async function historyBefore(weekStart) {
  const weeks = (await db.all('weeks')).filter(w => w.weekStart < weekStart).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return weeks.flatMap(w => (w.tenues || []).map(x => ({ label: `${x.key === 'WE' ? 'week-end' : 'semaine'} du ${x.dates[0]}`, itemIds: x.itemIds })))
    .filter(x => x.itemIds?.length).slice(-12);
}

async function runGeneration(week, keys, { instruction } = {}) {
  if (state.busy) return;
  state.busy = true;
  const list = document.querySelector('.days');
  list?.prepend(loader(instruction ? 'Le styliste modifie ta tenue…' : 'Le styliste compose ta semaine…'));
  document.querySelectorAll('.gen-card button, .day-card button').forEach(b => { b.disabled = true; });
  try {
    const weather = state._weather && Object.keys(state._weather).length ? state._weather
      : await fetchWeather(state.settings.lieu.lat, state.settings.lieu.lon).catch(() => ({}));
    const allSlots = slotsFor(week.weekStart);
    const slots = allSlots.filter(s => keys.includes(s.key));
    const fixed = week.tenues.filter(x => !keys.includes(x.key) && allSlots.some(s => s.key === x.key) && x.itemIds?.length)
      .map(x => ({ key: x.key, label: slotLabel(x), itemIds: x.itemIds }));
    const { tenues, problems } = await generateOutfits({
      settings: state.settings, profile: state.profile, items: state.items, slots, weather,
      history: await historyBefore(week.weekStart), fixed, weekNote: week.note,
      instruction, current: instruction ? week.tenues.filter(x => keys.includes(x.key)).map(x => ({ key: x.key, itemIds: x.itemIds })) : undefined,
    });
    if (!tenues.length) throw new AIError('Aucune tenue reçue. Réessaie.');
    for (const nt of tenues) {
      const old = week.tenues.find(x => x.key === nt.key);
      if (old?.porte) await setWear(old.itemIds, old.dates, false);
      week.tenues = week.tenues.filter(x => x.key !== nt.key).concat(nt);
    }
    // Les tenues hors du découpage actuel (après un changement d'organisation) sont remplacées.
    week.tenues = week.tenues.filter(x => allSlots.some(s => s.key === x.key && s.dates.join() === x.dates.join()));
    week.tenues.sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
    // Une simple modification garde les cases du sac déjà cochées pour les pièces toujours présentes.
    week.sac = instruction ? (week.sac || []).filter(id => week.tenues.some(t => t.itemIds.includes(id))) : [];
    week.generatedAt = new Date().toISOString();
    await saveWeek(week);
    snackbar(instruction ? 'Tenue modifiée ✨' : problems.length ? 'Tenues prêtes (quelques règles non respectées : vérifie-les).' : 'Ta semaine est prête ✨');
  } catch (e) {
    snackbar(errorText(e), { duration: 7000 });
  } finally {
    state.busy = false;
    rerender();
  }
}

// Modifier une tenue en langage naturel (« j'ai déjà porté cette chemise », « plus habillé pour la messe »…).
function editWithAI(week, slot, tenue) {
  if (!state.settings.apiKey) { snackbar('Ajoute d’abord ta clé Gemini dans Profil.'); return; }
  const items = byId();
  const ta = h('textarea', { rows: 3, placeholder: 'Ex. j’ai déjà porté cette chemise la semaine dernière, propose-m’en une autre' });
  const pieces = tenue.itemIds.map(id => items[id]).filter(Boolean);
  const chip = (label, text) => h('button', { type: 'button', class: 'chip', onclick: () => { ta.value = ta.value ? ta.value.replace(/\s*$/, '') + ' ; ' + text : text; ta.focus(); } }, label);
  const nom = (i) => i.nom.charAt(0).toLowerCase() + i.nom.slice(1);
  const go = () => {
    const txt = ta.value.trim();
    if (!txt) { ta.focus(); return; }
    layer.close();
    runGeneration(week, [slot.key], { instruction: txt });
  };
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted small' }, 'Dis au styliste ce que tu veux changer. Il garde le reste de la tenue.'),
    h('div', { class: 'chips' },
      pieces.filter(i => ['haut', 'maille'].includes(groupOf(i.categorie))).map(i => chip(`Déjà porté : ${i.nom.split(' ').slice(0, 3).join(' ')}…`, `j’ai déjà porté ${nom(i)} récemment, propose-m’en un autre`)),
      chip('Plus chaud', 'il va faire plus froid que prévu, rends la tenue plus chaude'),
      chip('Plus habillé', 'il me faut une tenue plus habillée (messe, oral)'),
      chip('Plus décontracté', 'rends la tenue plus décontractée'),
      chip('Autres couleurs', 'garde les mêmes types de pièces mais propose d’autres couleurs')),
    h('label', { class: 'field' }, h('span', {}, 'Ta demande'), ta),
    button('Modifier la tenue', { ic: 'auto_awesome', cls: 'wide', onclick: go }));
  const layer = sheet({ title: 'Modifier « ' + cleanAI(tenue.titre) + ' »', body });
  setTimeout(() => ta.focus(), 300);
}

async function setWear(ids, dates, on) {
  const items = byId();
  for (const id of ids) {
    const it = items[id];
    if (!it) continue;
    const set = new Set(it.porte || []);
    for (const d of dates) { if (on) set.add(d); else set.delete(d); }
    it.porte = [...set].sort();
    await saveItem(it);
  }
}

async function toggleWorn(week, tenue) {
  tenue.porte = !tenue.porte;
  await setWear(tenue.itemIds, tenue.dates, tenue.porte);
  await saveWeek(week);
  rerender();
}

// Note chaque remplaçant possible d'après le reste de la tenue, la météo, la saison et l'usage récent.
const SEASON_OF_MONTH = ['hiver', 'hiver', 'printemps', 'printemps', 'printemps', 'été', 'été', 'été', 'automne', 'automne', 'automne', 'hiver'];
const NEUTRES = /gris|anthracite|marine|bleu marine|noir|blanc|écru|ecru|beige|crème|creme|taupe/i;
// Chaleur réelle : la note de la fiche, corrigée par la matière (la laine tient plus chaud que le coton à note égale).
function warmthOf(o) {
  let c = o.chaleur || 3;
  const m = (o.matiere || '').toLowerCase();
  const pct = (re) => { const x = m.match(new RegExp('(\\d+)\\s*%\\s*(?:de\\s*)?(?:' + re + ')')); return x ? Number(x[1]) : null; };
  const wool = /laine|mérinos|merinos|cachemire|lambswool|alpaga|mohair/.test(m);
  const woolPct = pct('laine|mérinos|merinos|cachemire|lambswool|alpaga|mohair');
  if (wool && (woolPct == null || woolPct >= 70)) c += 1;
  else if (wool && woolPct >= 30) c += 0.5;
  else if (/coton|lin\b/.test(m) && !wool) c -= 0.5;
  return Math.max(1, Math.min(5, c));
}
function rankReplacements(options, { tenue, id, w, week, items }) {
  const others = tenue.itemIds.filter(x => x !== id).map(x => items[x]).filter(Boolean);
  const formMean = others.length ? others.reduce((s, o) => s + (o.formalite || 3), 0) / others.length : 3;
  const season = SEASON_OF_MONTH[Number(tenue.dates[0].slice(5, 7)) - 1];
  const tmoy = w ? (w.tmin + w.tmax) / 2 : null;
  const warmTarget = tmoy == null ? null : tmoy <= 3 ? 5 : tmoy <= 8 ? 4 : tmoy <= 13 ? 3 : tmoy <= 19 ? 2 : 1;
  const g = groupOf(items[id].categorie);
  const weatherMatters = ['maille', 'dessus', 'bas'].includes(g);
  const otherTenues = (week.tenues || []).filter(t => t !== tenue);
  const usedElsewhere = new Set(otherTenues.flatMap(t => t.itemIds));
  const aimees = (state.profile.couleursAimees || '').toLowerCase();
  const evitees = (state.profile.couleursEvitees || '').toLowerCase();
  const otherColors = others.map(o => (o.couleurPrincipale || '').toLowerCase()).filter(Boolean);
  const weekAgo = addDays(tenue.dates[0], -7);
  return options.map(o => {
    let score = 0; const why = [];
    const col = (o.couleurPrincipale || '').toLowerCase();
    // Saison
    if (o.saisons?.length) { if (o.saisons.includes(season)) { score += 2; why.push('de saison'); } else score -= 3; }
    // Météo (chaleur de la pièce)
    if (weatherMatters && warmTarget != null) {
      const warm = warmthOf(o);
      // Par temps froid, une pièce un cran plus chaude n'est pas un défaut (on enlève le manteau à l'intérieur).
      const d = warm > warmTarget && tmoy < 10 ? Math.max(0, warm - warmTarget - 1) : Math.abs(warm - warmTarget);
      score += 3 - 1.5 * d;
      if (d <= 0.5) why.push(`adapté à ${Math.round(w.tmin)}–${Math.round(w.tmax)}°`);
      else if (d >= 2) why.push(warm < warmTarget ? 'un peu léger pour la météo' : 'un peu chaud pour la météo');
      if (warmTarget >= 4 && /laine|mérinos|merinos|cachemire|lambswool|alpaga|mohair|tweed|flanelle/i.test(o.matiere || '')) why.push('en laine');
    }
    // Niveau d'habillé cohérent avec le reste
    const fd = Math.abs((o.formalite || 3) - formMean);
    score += 2 - fd;
    if (fd <= 0.5) why.push('même niveau d’habillé');
    // Couleurs
    const first = col.split(/[\s-]/)[0];
    if (first && first.length > 2 && aimees.includes(first)) { score += 1.5; why.push('dans ta palette'); }
    if (first && first.length > 2 && evitees.includes(first)) score -= 1.5;
    if (col && !NEUTRES.test(col) && otherColors.some(c => !NEUTRES.test(c) && c.split(/[\s-]/)[0] === first)) score -= 1;
    // Le même manteau toute la semaine (bagage léger) ; pas deux fois le même haut
    if (usedElsewhere.has(o.id)) {
      if (g === 'dessus' || g === 'chaussures' || g === 'bas') { score += 1.5; why.push('déjà dans le sac cette semaine'); }
      else score -= 2;
    }
    // Porté récemment, état
    const last = (o.porte || []).filter(d => d < tenue.dates[0]).pop();
    if (last && last >= weekAgo) score -= 1;
    if (o.etat === 'Satisfaisant') score -= 1.5;
    if (w?.pluieProba >= 60 && /daim|suède|suede/i.test([o.matiere, o.nom].join(' '))) { score -= 2; why.push('craint la pluie'); }
    return { o, score, why: why.slice(0, 3) };
  }).sort((a, b) => b.score - a.score);
}

function swapPiece(week, tenue, id, w) {
  const items = byId();
  const current = items[id];
  const g = groupOf(current.categorie);
  const options = state.items.filter(i => i.statut === 'garde' && groupOf(i.categorie) === g && !tenue.itemIds.includes(i.id));
  const replace = async (newId) => {
    layer.close();
    if (tenue.porte) { await setWear([id], tenue.dates, false); if (newId) await setWear([newId], tenue.dates, true); }
    tenue.itemIds = tenue.itemIds.map(x => (x === id ? newId : x)).filter(Boolean);
    tenue.itemIds.sort((a, b) => GROUP_ORDER.indexOf(groupOf(items[a]?.categorie)) - GROUP_ORDER.indexOf(groupOf(items[b]?.categorie)));
    week.sac = (week.sac || []).filter(x => x !== id);
    await saveWeek(week);
    rerender();
  };
  const ranked = rankReplacements(options, { tenue, id, w, week, items });
  const best = ranked.length > 1 ? ranked.slice(0, ranked.length > 4 ? 3 : 1) : [];
  const rest = ranked.filter(r => !best.includes(r));
  // Vignette = voir en grand ; reste de la ligne = choisir.
  const pick = (r, isBest) => h('div', { class: 'pick-row' },
    zoomThumb(r.o, 'small'),
    h('button', { class: 'pick' + (isBest ? ' best' : ''), type: 'button', onclick: () => replace(r.o.id) },
      h('span', {}, h('strong', {}, r.o.nom), h('small', {}, `${r.o.categorie} · ${r.o.couleurPrincipale || ''}`),
        isBest && r.why.length ? h('span', { class: 'why' }, r.why.join(' · ')) : null)));
  const body = h('div', { class: 'pick-list' },
    h('div', { class: 'pick-row' }, zoomThumb(current, 'small'), h('p', { class: 'muted' }, `Remplacer « ${current.nom} » par :`)),
    options.length ? [
      best.length ? [h('h4', { class: 'pick-head' }, icon('auto_awesome', 'tiny'), ' Les mieux adaptés à cette tenue'), best.map(r => pick(r, true))] : null,
      rest.length ? [best.length ? h('h4', { class: 'pick-head' }, 'Autres pièces') : null, rest.map(r => pick(r, false))] : null,
    ] : h('p', {}, 'Aucune autre pièce de ce type dans ta garde-robe.'),
    ['haut', 'bas', 'chaussures'].includes(g) ? null :
      button('Retirer de la tenue', { kind: 'text', ic: 'remove_circle', onclick: () => replace(null) }));
  const layer = sheet({ title: GROUPS[g].label, body });
}

/* =========================================================== GARDE-ROBE */
function renderWardrobe() {
  const v = view();
  const f = state.filter;
  const search = h('input', { type: 'search', placeholder: 'Rechercher (couleur, marque, matière…)', value: f.q,
    oninput: debounce(() => { f.q = search.value; saveFilter(); paintGrid(); }, 200) });
  v.append(h('div', { class: 'searchbar' }, icon('search'), search));

  const statutChips = h('div', { class: 'segmented' },
    [['garde', 'Gardés'], ['vente', 'À vendre'], ['vendu', 'Vendus'], ['all', 'Tous']].map(([k, l]) =>
      h('button', { type: 'button', class: f.statut === k ? 'on' : '', onclick: () => { f.statut = k; saveFilter(); rerender(); } },
        f.statut === k ? icon('check') : null, l)));
  const groupChips = h('div', { class: 'chips scroll' },
    [['all', 'Tout', 'apps'], ...GROUP_ORDER.map(g => [g, GROUPS[g].label, GROUPS[g].icon])].map(([k, l, ic]) =>
      h('button', { type: 'button', class: 'chip' + (f.group === k ? ' on' : ''), onclick: () => { f.group = k; saveFilter(); rerender(); } }, icon(ic), l)));
  v.append(statutChips, groupChips);

  const count = h('p', { class: 'muted small' });
  const grid = h('div', { class: 'grid' });
  v.append(count, grid);

  function paintGrid() {
    const q = f.q.toLowerCase().trim();
    const list = state.items.filter(i =>
      (f.group === 'all' || groupOf(i.categorie) === f.group) &&
      (f.statut === 'all' || (f.statut === 'garde' && i.statut === 'garde') ||
        (f.statut === 'vente' && ['a_vendre', 'en_vente'].includes(i.statut)) ||
        (f.statut === 'vendu' && ['vendu', 'donne'].includes(i.statut))) &&
      (!q || [i.nom, i.categorie, i.couleurPrincipale, i.marque, i.matiere, i.motif, i.taille, ...(i.couleursSecondaires || [])]
        .join(' ').toLowerCase().includes(q)));
    count.textContent = `${list.length} pièce${list.length > 1 ? 's' : ''}`;
    if (!list.length) {
      grid.replaceChildren(h('div', { class: 'empty' }, icon('checkroom', 'big'),
        h('p', {}, state.items.length ? 'Aucune pièce ne correspond.' : 'Ta garde-robe est vide. Sors tout de l’armoire et ajoute chaque pièce en photo : l’IA remplit la fiche pour toi.')));
      return;
    }
    grid.replaceChildren(...list.map(i => h('button', { class: 'item-card', type: 'button', onclick: () => openItemEditor(i) },
      thumb(i),
      i.statut !== 'garde' ? h('span', { class: 'badge' }, icon(STATUTS[i.statut].icon), STATUTS[i.statut].label) : null,
      h('span', { class: 'item-name' }, i.nom || i.categorie),
      h('span', { class: 'item-meta' }, [i.categorie, i.taille].filter(Boolean).join(' · ')))));
  }
  paintGrid();

  v.append(h('button', { class: 'fab extended', type: 'button', onclick: () => openItemEditor(null) },
    icon('add_a_photo'), h('span', {}, 'Ajouter')));
}

/* ------------------------------------------- Éditeur de vêtement */
async function openItemEditor(existing, { afterSave, preset } = {}) {
  const isNew = !existing;
  const it = existing ? structuredClone(existing) : {
    id: null, categorie: 'Chemise', nom: '', couleurPrincipale: '', couleursSecondaires: [], motif: '', matiere: '',
    col: '', manches: '', coupe: '', marque: '', taille: '', saisons: [], formalite: 3, chaleur: 3, etat: 'Très bon état',
    mesures: {}, notes: '', statut: 'garde', porte: [], photoIds: [], ...(preset || {}),
  };
  it.mesures ||= {};
  // Photos : existantes (en base) + nouvelles
  const photos = [];
  for (const pid of it.photoIds || []) {
    const p = await db.get('photos', pid);
    if (p) photos.push({ ...p, url: URL.createObjectURL(p.blob) });
  }
  const removed = [];
  let dirty = false, saving = false, aiRunning = false;

  const photoRow = h('div', { class: 'photo-row' });
  const camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => addFiles(e.target.files) });
  const galInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => addFiles(e.target.files) });
  const aiBtn = button('Remplir la fiche avec l’IA', { kind: 'tonal', ic: 'auto_awesome', cls: 'wide', onclick: runAI });
  const aiZone = h('div', {});

  async function addFiles(files) {
    dirty = true;
    for (const f of [...files].slice(0, 6 - photos.length)) {
      try {
        const { blob, thumb: th } = await processImage(f);
        photos.push({ id: null, blob, thumb: th, url: URL.createObjectURL(blob), isNew: true });
      } catch { snackbar('Une image n’a pas pu être lue.'); }
    }
    camInput.value = ''; galInput.value = '';
    paintPhotos();
  }
  function paintPhotos() {
    fill(photoRow,
      ...photos.map((p, idx) => h('div', { class: 'photo' },
        h('img', { src: p.url, alt: `Photo ${idx + 1} (agrandir)`, class: 'zoomable', onclick: () => photoViewer(photos.map(x => x.url), idx) }),
        idx === 0 ? h('span', { class: 'photo-main' }, 'Principale') : null,
        h('button', { class: 'photo-del', type: 'button', 'aria-label': 'Retirer la photo', onclick: () => {
          const [r] = photos.splice(idx, 1); if (r.id) removed.push(r.id); URL.revokeObjectURL(r.url); dirty = true; paintPhotos();
        } }, icon('close')))),
      photos.length < 6 ? h('button', { class: 'photo add', type: 'button', onclick: () => camInput.click() }, icon('photo_camera'), h('span', {}, 'Photo')) : null,
      photos.length < 6 ? h('button', { class: 'photo add', type: 'button', onclick: () => galInput.click() }, icon('photo_library'), h('span', {}, 'Galerie')) : null);
    aiBtn.disabled = !photos.length;
  }

  async function runAI() {
    if (!state.settings.apiKey) { snackbar('Ajoute d’abord ta clé Gemini dans Profil.'); return; }
    aiBtn.disabled = true; aiRunning = true; dirty = true;
    aiZone.replaceChildren(loader('Analyse des photos…'));
    try {
      const res = await analyseItem(state.settings, photos.map(p => p.blob));
      Object.assign(it, res, { mesures: it.mesures, statut: it.statut, porte: it.porte });
      if (!res.notes) it.notes = existing?.notes || '';
      paintForm();
      aiZone.replaceChildren(h('p', { class: 'ok small' }, icon('check_circle', 'tiny'), ' Fiche pré-remplie. Vérifie et corrige si besoin.'));
    } catch (e) {
      aiZone.replaceChildren(h('p', { class: 'err small' }, errorText(e)));
    } finally { aiRunning = false; aiBtn.disabled = !photos.length; }
  }

  const form = h('div', { class: 'form' });
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });
  form.addEventListener('click', (e) => { if (e.target.closest('button')) dirty = true; });
  function paintForm() {
    const g = groupOf(it.categorie);
    const txt = (key, label, ph = '') => {
      const inp = h('input', { type: 'text', value: it[key] || '', placeholder: ph, oninput: () => { it[key] = inp.value; } });
      return h('label', { class: 'field' }, h('span', {}, label), inp);
    };
    const sel = (key, label, options, onchange) => {
      const s = h('select', { onchange: () => { it[key] = s.value; onchange?.(); } },
        options.map(o => h('option', { value: o, selected: it[key] === o ? 'selected' : null }, o)));
      return h('label', { class: 'field' }, h('span', {}, label), s);
    };
    const slider = (key, label, labels) => {
      const out = h('em', {}, labels[it[key] || 3]);
      const r = h('input', { type: 'range', min: 1, max: 5, step: 1, value: it[key] || 3,
        oninput: () => { it[key] = Number(r.value); out.textContent = labels[it[key]]; } });
      return h('label', { class: 'field' }, h('span', {}, label, ' : ', out), r);
    };
    const cols = h('input', { type: 'text', value: (it.couleursSecondaires || []).join(', '), placeholder: 'Ex. blanc, bordeaux',
      oninput: () => { it.couleursSecondaires = cols.value.split(',').map(s => s.trim()).filter(Boolean); } });
    const catOptions = Object.keys(CATEGORIES);
    const statutSel = h('select', { onchange: () => { it.statut = statutSel.value; } },
      Object.entries(STATUTS).map(([k, s]) => h('option', { value: k, selected: it.statut === k ? 'selected' : null }, s.label)));

    fill(form,
      h('h3', { class: 'section-title' }, 'Identité'),
      sel('categorie', 'Catégorie', catOptions, paintForm),
      txt('nom', 'Nom', 'Ex. Chemise oxford bleu ciel'),
      h('div', { class: 'two' }, txt('marque', 'Marque'), txt('taille', 'Taille (étiquette)')),
      h('h3', { class: 'section-title' }, 'Aspect'),
      h('div', { class: 'two' }, txt('couleurPrincipale', 'Couleur principale'), h('label', { class: 'field' }, h('span', {}, 'Autres couleurs'), cols)),
      h('div', { class: 'two' }, txt('motif', 'Motif', 'uni, rayé…'), txt('matiere', 'Matière', '100 % coton')),
      h('div', { class: 'two' }, txt('col', 'Col'), txt('manches', 'Manches')),
      txt('coupe', 'Coupe', 'slim, droite, regular…'),
      h('h3', { class: 'section-title' }, 'Usage'),
      h('div', { class: 'field' }, h('span', {}, 'Saisons'),
        h('div', { class: 'chips' }, SAISONS.map(s => {
          const b = h('button', { type: 'button', class: 'chip' + (it.saisons?.includes(s) ? ' on' : ''), onclick: () => {
            it.saisons = it.saisons?.includes(s) ? it.saisons.filter(x => x !== s) : [...(it.saisons || []), s];
            b.classList.toggle('on');
          } }, s);
          return b;
        }))),
      slider('formalite', 'Formalité', FORMALITE),
      slider('chaleur', 'Chaleur', CHALEUR),
      h('div', { class: 'two' }, sel('etat', 'État', ETATS), h('label', { class: 'field' }, h('span', {}, 'Statut'), statutSel)),
      h('h3', { class: 'section-title' }, 'Mesures à plat (cm)'),
      h('p', { class: 'muted small' }, 'Utiles surtout pour les pièces à vendre ou dont tu doutes de la coupe.'),
      h('div', { class: 'two' }, MEASURES[g].map(([k, l]) => {
        const inp = h('input', { type: 'number', inputmode: 'decimal', step: '0.5', min: 0, value: it.mesures[k] ?? '',
          oninput: () => { if (inp.value === '') delete it.mesures[k]; else it.mesures[k] = Number(inp.value); } });
        return h('label', { class: 'field' }, h('span', {}, l), inp);
      })),
      h('label', { class: 'field' }, h('span', {}, 'Notes (défauts, particularités)'),
        (() => { const ta = h('textarea', { rows: 3, oninput: () => { it.notes = ta.value; } }); ta.value = it.notes || ''; return ta; })()),
      existing?.porte?.length ? h('p', { class: 'muted small' }, `Portée ${existing.porte.length} fois (dernière : ${fmtDay(existing.porte[existing.porte.length - 1], { day: 'numeric', month: 'long' })}).`) : null,
    );
  }

  async function save(andNext = false) {
    if (saving) return;   // double appui : une seule pièce enregistrée
    if (aiRunning) { snackbar('Attends la fin de l’analyse avant d’enregistrer.'); return; }
    saving = true;
    try { await doSave(andNext); } finally { saving = false; }
  }
  async function doSave(andNext) {
    if (!it.nom.trim()) it.nom = [it.categorie, it.couleurPrincipale].filter(Boolean).join(' ');
    if (!it.id) { it.id = await nextItemId(); it.createdAt = new Date().toISOString(); }
    for (const pid of removed) await db.del('photos', pid);
    const ids = [];
    for (const p of photos) {
      if (!p.id) { p.id = `${it.id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
      if (p.isNew) { await db.put('photos', { id: p.id, itemId: it.id, blob: p.blob, thumb: p.thumb }); p.isNew = false; }
      ids.push(p.id);
    }
    it.photoIds = ids;
    it.thumb = photos[0]?.thumb || null;
    if (it.statut === 'vendu' && !it.dateVente) it.dateVente = today();
    await saveItem(it);
    dirty = false;
    layer.close(false, true);
    snackbar(isNew ? 'Pièce ajoutée' : 'Modifications enregistrées');
    if (andNext) setTimeout(() => openItemEditor(null, { afterSave }), 300);
    else if (afterSave) setTimeout(() => afterSave(it), 300);
    if (!afterSave || andNext) rerender();
  }

  async function remove() {
    if (!(await confirmBox(`Supprimer « ${it.nom || it.categorie} » et ses photos ?`, { ok: 'Supprimer', danger: true }))) return;
    for (const pid of it.photoIds || []) await db.del('photos', pid);
    await db.del('items', it.id);
    state.items = state.items.filter(x => x.id !== it.id);
    layer.close(false, true);
    snackbar('Pièce supprimée');
    rerender();
  }

  paintPhotos();
  paintForm();
  const body = h('div', { class: 'editor' },
    camInput, galInput,
    h('p', { class: 'muted small' }, isNew ? 'Photographie le vêtement à plat ou sur cintre, puis l’étiquette (composition et taille).' : ''),
    photoRow, aiBtn, aiZone, form,
    h('div', { class: 'row wrap end editor-actions' },
      isNew ? null : button('Supprimer', { kind: 'text', ic: 'delete', cls: 'danger-text', onclick: remove }),
      isNew ? button('Enregistrer et suivant', { kind: 'tonal', ic: 'library_add', onclick: () => save(true) }) : null,
      button('Enregistrer', { ic: 'check', onclick: () => save(false) })));
  const layer = fullDialog({
    title: isNew ? 'Nouvelle pièce' : (it.nom || 'Pièce'), body,
    actions: [button('Enregistrer', { kind: 'text', onclick: () => save(false) })],
    onClose: () => photos.forEach(p => URL.revokeObjectURL(p.url)),
  });
  // Fermeture (croix ou retour Android) avec des changements non enregistrés : on demande.
  layer.guard = async () => !dirty || confirmBox(isNew ? 'Fermer sans enregistrer ? Les photos et la fiche seront perdues.' : 'Fermer sans enregistrer les modifications ?',
    { ok: 'Fermer sans enregistrer', danger: true });
}

/* =========================================================== STYLISTE (chat) */
const QUICK = [
  ['Juger une trouvaille', 'image', 'Voici une annonce que j’ai trouvée. Est-ce qu’elle correspond à mon style, à la saison et à ma taille ? Verdict clair et prix juste.'],
  ['Juger ma tenue', 'checkroom', 'Voici ma tenue du jour. Examine-la scrupuleusement et dis-moi ce qui va et ce qui ne va pas, puis comment corriger avec mes pièces.'],
  ['Que m’acheter ?', 'shopping_bag', 'Qu’est-ce qui manque le plus à ma garde-robe en ce moment ? Donne-moi 3 pièces à chercher sur Vinted, avec les mots-clés et la taille.'],
  ['Associer une pièce', 'style', 'Avec quoi puis-je porter '],
];
let pendingImages = [];   // images jointes au prochain message
let sharedText = '';

// À chaque ouverture : y a-t-il une capture partagée en attente ?
async function scanInbox() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('inbox');
    const ids = (await cache.keys()).map(r => new URL(r.url).pathname.match(/\/inbox\/([a-z0-9]+)$/)?.[1]).filter(Boolean);
    if (!ids.length) return;
    for (const id of ids) await loadSharedInbox(id, { silent: true });
    if (pendingImages.length || sharedText) {
      if (location.hash !== '#/styliste') location.hash = '#/styliste'; else rerender();
      snackbar('Capture reçue : pose ta question au styliste.');
    }
  } catch { /* rien */ }
}

async function loadSharedInbox(id, { silent = false } = {}) {
  try {
    const cache = await caches.open('inbox');
    const meta = await (await cache.match(`./inbox/${id}`))?.json();
    if (!meta) return;
    for (const name of meta.files) {
      const r = await cache.match(name);
      if (!r) continue;
      const blob = await r.blob();
      const { blob: small, thumb: th } = await processImage(blob);
      pendingImages.push({ blob: small, thumb: th });
      await cache.delete(name);
    }
    await cache.delete(`./inbox/${id}`);
    sharedText = meta.text || sharedText;
    if (!silent) { rerender(); if (pendingImages.length) snackbar('Capture reçue : pose ta question au styliste.'); }
  } catch { /* rien à récupérer */ }
}

function renderMarkdown(text) {
  const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  const out = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (!line.trim()) continue;
    const hd = line.match(/^#{1,4}\s+(.*)$/);
    out.push(hd ? `<p><strong>${inline(hd[1])}</strong></p>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  const div = h('div', { class: 'md' });
  div.innerHTML = out.join('');
  return div;
}

async function renderStyliste() {
  const v = view();
  const messages = (await db.all('chat')).sort((a, b) => a.ts - b.ts);
  const kept = state.items.filter(i => i.statut === 'garde');
  if (!state.settings.apiKey) v.append(needKeyCard());

  const thread = h('div', { class: 'thread' });
  if (!messages.length) {
    thread.append(h('section', { class: 'card tonal intro' },
      h('h3', {}, icon('forum'), ' Ton styliste'),
      h('p', {}, `Il connaît ton profil, tes règles de style et tes ${kept.length} pièces. Parle-lui de style, montre-lui une annonce Vinted ou une photo de toi en tenue : il juge avec rigueur, en tenant compte de ce que tu as vraiment dans l’armoire.`),
      h('p', { class: 'small' }, 'Astuce : depuis Vinted ou ta galerie, « Partager » → « Garde-robe » envoie la capture directement ici.')));
  }
  for (const m of messages) thread.append(bubble(m));
  v.append(thread);

  // Composer
  const preview = h('div', { class: 'attach-row' });
  const paintPreview = () => fill(preview, pendingImages.map((p, i) => h('div', { class: 'attach' },
    h('img', { src: p.thumb, alt: 'Image jointe' }),
    h('button', { class: 'photo-del', type: 'button', 'aria-label': 'Retirer', onclick: () => { pendingImages.splice(i, 1); paintPreview(); } }, icon('close')))));
  paintPreview();
  const input = h('textarea', { rows: 1, placeholder: 'Écris au styliste…', oninput: () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; } });
  if (sharedText) { input.value = sharedText; sharedText = ''; }
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async (e) => {
    for (const f of [...e.target.files].slice(0, 4 - pendingImages.length)) {
      try { const r = await processImage(f); pendingImages.push(r); } catch { snackbar('Image illisible'); }
    }
    fileIn.value = ''; paintPreview();
  } });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { pendingImages.push(await processImage(f)); } catch { snackbar('Image illisible'); }
    camIn.value = ''; paintPreview();
  } });
  const sendBtn = h('button', { class: 'send', type: 'button', 'aria-label': 'Envoyer', onclick: () => send() }, icon('send'));
  const quick = h('div', { class: 'chips scroll quick' }, QUICK.map(([l, ic, txt]) => h('button', { type: 'button', class: 'chip', onclick: () => {
    input.value = txt; input.focus(); input.dispatchEvent(new Event('input'));
    if ((ic === 'image' || ic === 'checkroom') && !pendingImages.length) fileIn.click();
  } }, icon(ic), l)));
  const composer = h('div', { class: 'composer' }, preview, quick,
    h('div', { class: 'composer-row' },
      iconButton('photo_camera', 'Prendre une photo', () => camIn.click()),
      iconButton('image', 'Joindre une image', () => fileIn.click()),
      input, sendBtn, fileIn, camIn));
  v.append(composer);
  document.getElementById('topActions').append(iconButton('delete_sweep', 'Nouvelle conversation', async () => {
    if (!messages.length || await confirmBox('Effacer la conversation ? Le styliste gardera ta garde-robe en mémoire, mais pas cet échange.', { ok: 'Effacer', danger: true })) {
      await db.clear('chat'); pendingImages = []; rerender();
    }
  }));
  thread.scrollIntoView?.({ block: 'end' });
  window.scrollTo(0, document.body.scrollHeight);

  async function send() {
    const text = input.value.trim();
    if (!text && !pendingImages.length) return;
    if (!state.settings.apiKey) { snackbar('Ajoute d’abord ta clé Gemini dans Profil.'); return; }
    if (state.busy) return;
    state.busy = true; sendBtn.disabled = true;
    const images = pendingImages.splice(0);
    paintPreview();
    input.value = ''; input.style.height = 'auto';
    const userMsg = { id: 'm' + Date.now(), role: 'user', text, ts: Date.now(), images: images.map(i => ({ blob: i.blob, thumb: i.thumb })) };
    await db.put('chat', userMsg);
    thread.querySelector('.intro')?.remove();
    thread.append(bubble(userMsg));
    const wait = h('div', { class: 'bubble model thinking' }, h('div', { class: 'loader small' }), h('span', {}, 'Le styliste réfléchit…'));
    thread.append(wait);
    window.scrollTo(0, document.body.scrollHeight);
    try {
      const weeks = await db.all('weeks');
      const context = wardrobeContext({ profile: state.profile, items: state.items, weeks, today: today() });
      const history = messages.concat([]).slice(-20);
      const recentUsers = history.filter(m => m.role === 'user').slice(-2);
      const hist = history.map(m => ({
        role: m.role, text: m.text,
        sendImages: recentUsers.includes(m) ? (m.images || []).map(i => i.blob) : [],
        imageNote: !recentUsers.includes(m) && m.images?.length ? `[${m.images.length} image(s) jointe(s) précédemment]` : '',
      }));
      const act = chatActions();
      const reply = await chatTurn({ settings: state.settings, context, history: hist, message: text, images: images.map(i => i.blob), execute: act.execute });
      const modelMsg = { id: 'm' + (Date.now() + 1), role: 'model', text: reply, ts: Date.now() + 1,
        actions: act.done.length ? act.done : undefined, undo: act.undo.length ? act.undo : undefined };
      await db.put('chat', modelMsg);
      messages.push(userMsg, modelMsg);
      wait.replaceWith(bubble(modelMsg));
    } catch (e) {
      wait.replaceWith(h('div', { class: 'bubble model err' }, errorText(e)));
      messages.push(userMsg);
    } finally {
      state.busy = false; sendBtn.disabled = false;
      window.scrollTo(0, document.body.scrollHeight);
    }
  }
}

function bubble(m) {
  const b = h('div', { class: 'bubble ' + m.role });
  if (m.images?.length) b.append(h('div', { class: 'bubble-imgs' }, m.images.map(i => h('img', { src: i.thumb, alt: 'Image' }))));
  if (m.actions?.length) {
    const box = h('div', { class: 'chat-actions' + (m.undone ? ' undone' : '') },
      h('ul', {}, m.actions.map(a => h('li', {}, icon(m.undone ? 'undo' : 'check_circle', 'tiny'), ' ', a))),
      m.undone ? h('p', { class: 'small muted' }, 'Changements annulés.')
        : m.undo?.length ? button('Annuler ces changements', { kind: 'text', ic: 'undo', onclick: async () => {
          if (!(await confirmBox('Annuler les changements faits par le styliste dans ce message ?', { ok: 'Annuler les changements' }))) return;
          await undoChatActions(m); snackbar('Changements annulés'); rerender();
        } }) : null);
    b.append(box);
  }
  if (m.text) b.append(m.role === 'model' ? renderMarkdown(cleanAI(m.text)) : h('p', {}, m.text));
  if (m.role === 'model') b.append(iconButton('content_copy', 'Copier', () => copyText(m.text), 'copy'));
  return b;
}

/* ---------- Outils du styliste : ce que l'IA peut faire dans l'appli ---------- */
const ITEM_FIELDS = ['nom', 'categorie', 'marque', 'taille', 'couleurPrincipale', 'couleursSecondaires', 'motif', 'matiere', 'col', 'manches',
  'coupe', 'saisons', 'formalite', 'chaleur', 'etat', 'statut', 'notes', 'mesures'];
const PROFILE_FIELDS = [...PROFILE_TASTES.map(x => x[0]), ...PROFILE_SIZES.map(x => x[0]), ...PROFILE_MEASURES.map(x => x[0])];
const FIELD_LABEL = { nom: 'nom', categorie: 'catégorie', marque: 'marque', taille: 'taille', couleurPrincipale: 'couleur', couleursSecondaires: 'autres couleurs',
  motif: 'motif', matiere: 'matière', col: 'col', manches: 'manches', coupe: 'coupe', saisons: 'saisons', formalite: 'formalité', chaleur: 'chaleur',
  etat: 'état', statut: 'statut', notes: 'notes', mesures: 'mesures' };

function chatActions() {
  const done = [], undo = [];
  const snap = (kind, key, before) => { if (!undo.some(u => u.kind === kind && u.key === key)) undo.push({ kind, key, before: structuredClone(before ?? null) }); };
  const getWeek = async (semaine) => {
    const ws = /^\d{4}-\d{2}-\d{2}$/.test(semaine || '') ? mondayOf(semaine) : state.weekStart;
    return normalizeWeek((await db.get('weeks', ws)) || { weekStart: ws, note: '' });
  };
  const items = () => byId();
  const tools = {
    async modifier_piece({ id, modifications = {} }) {
      const it = items()[id];
      if (!it) return { erreur: `pièce ${id} introuvable` };
      const before = structuredClone(it);
      const changed = [];
      for (const [k, v0] of Object.entries(modifications)) {
        if (!ITEM_FIELDS.includes(k) || v0 == null) continue;
        let v = v0;
        if (k === 'categorie') { v = Object.keys(CATEGORIES).find(c => c.toLowerCase() === String(v).toLowerCase()); if (!v) return { erreur: `catégorie inconnue : ${v0}` }; }
        if (k === 'etat') { v = ETATS.find(e => e.toLowerCase() === String(v).toLowerCase()); if (!v) return { erreur: `état inconnu : ${v0}` }; }
        if (k === 'statut' && !STATUTS[v]) return { erreur: `statut inconnu : ${v0}` };
        if (k === 'saisons') v = (Array.isArray(v) ? v : [v]).map(x => SAISONS.find(sa => sa === String(x).toLowerCase())).filter(Boolean);
        if (k === 'formalite' || k === 'chaleur') { v = Math.round(Number(v)); if (!(v >= 1 && v <= 5)) return { erreur: `${k} doit être entre 1 et 5` }; }
        if (k === 'couleursSecondaires') v = (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);
        if (k === 'mesures') { v = { ...(it.mesures || {}) }; for (const [mk, mv] of Object.entries(v0 || {})) { const n = Number(mv); if (n > 0) v[mk] = n; } }
        if (typeof v === 'string') v = v.trim().slice(0, 600);
        it[k] = v; changed.push(FIELD_LABEL[k] || k);
      }
      if (!changed.length) return { erreur: 'aucun champ modifiable fourni' };
      if (it.statut === 'vendu' && !it.dateVente) it.dateVente = today();
      snap('item', id, before);
      await saveItem(it);
      done.push(`Fiche « ${it.nom} » : ${changed.join(', ')}`);
      return { ok: true, piece: it.nom, champs: changed };
    },
    async modifier_tenue({ semaine, cle, itemIds = [], titre, explication }) {
      const week = await getWeek(semaine);
      const key = String(cle || '').toUpperCase();
      const slots = slotsFor(week.weekStart);
      const slot = slots.find(x => x.key === key);
      if (!slot) return { erreur: `pas de tenue ${key} dans le découpage actuel (${slots.map(x => x.key).join(', ')})` };
      const all = items();
      const bad = itemIds.filter(id => !all[id] || all[id].statut !== 'garde');
      if (bad.length) return { erreur: `pièces inconnues ou plus dans la garde-robe : ${bad.join(', ')}` };
      if (!itemIds.length) return { erreur: 'la tenue doit contenir des pièces' };
      snap('week', week.weekStart, await db.get('weeks', week.weekStart));
      let t = week.tenues.find(x => x.key === key && x.dates.join() === slot.dates.join());
      if (!t) { t = { key, dates: slot.dates, itemIds: [], titre: 'Tenue', explication: '', porte: false }; week.tenues.push(t); }
      const ids = [...new Set(itemIds)].sort((a, b) => GROUP_ORDER.indexOf(groupOf(all[a].categorie)) - GROUP_ORDER.indexOf(groupOf(all[b].categorie)));
      if (t.porte) {
        for (const id of t.itemIds.filter(x => !ids.includes(x))) { snap('item', id, all[id]); }
        for (const id of ids.filter(x => !t.itemIds.includes(x))) { snap('item', id, all[id]); }
        await setWear(t.itemIds.filter(x => !ids.includes(x)), t.dates, false);
        await setWear(ids.filter(x => !t.itemIds.includes(x)), t.dates, true);
      }
      t.itemIds = ids;
      if (titre) t.titre = titre;
      if (explication) t.explication = explication;
      week.tenues.sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
      week.sac = (week.sac || []).filter(id => week.tenues.some(x => x.itemIds.includes(id)));
      await saveWeek(week);
      done.push(`Tenue ${slotLabel(slot).toLowerCase()} (semaine du ${fmtDay(week.weekStart, { day: 'numeric', month: 'long' })}) modifiée`);
      return { ok: true, tenue: ids.map(id => all[id].nom) };
    },
    async marquer_tenue_portee({ semaine, cle, portee }) {
      const week = await getWeek(semaine);
      const t = week.tenues.find(x => x.key === String(cle || '').toUpperCase());
      if (!t) return { erreur: 'tenue introuvable' };
      if (!!t.porte === !!portee) return { ok: true, info: 'déjà dans cet état' };
      snap('week', week.weekStart, await db.get('weeks', week.weekStart));
      for (const id of t.itemIds) snap('item', id, items()[id]);
      t.porte = !!portee;
      await setWear(t.itemIds, t.dates, t.porte);
      await saveWeek(week);
      done.push(`Tenue « ${cleanAI(t.titre)} » marquée ${t.porte ? 'portée' : 'non portée'}`);
      return { ok: true };
    },
    async remarques_semaine({ semaine, remarques }) {
      const week = await getWeek(semaine);
      snap('week', week.weekStart, await db.get('weeks', week.weekStart));
      week.note = String(remarques || '').slice(0, 1000);
      await saveWeek(week);
      done.push(`Remarques de la semaine du ${fmtDay(week.weekStart, { day: 'numeric', month: 'long' })} mises à jour`);
      return { ok: true };
    },
    async modifier_profil({ champ, valeur }) {
      if (!PROFILE_FIELDS.includes(champ)) return { erreur: `champ inconnu : ${champ}` };
      snap('profile', 'profile', state.profile);
      state.profile[champ] = String(valeur ?? '').slice(0, 4000);
      await db.setKV('profile', state.profile);
      scheduleAutoBackup();
      const lbl = [...PROFILE_TASTES, ...PROFILE_SIZES, ...PROFILE_MEASURES].find(x => x[0] === champ)?.[1] || champ;
      done.push(`Profil : « ${lbl} » mis à jour`);
      return { ok: true };
    },
    async ajouter_achat(a) {
      if (!a.nom) return { erreur: 'nom manquant' };
      snap('wishlist', 'wishlist', state.wishlist);
      state.wishlist = state.wishlist.concat({ ...a, id: 'w' + Date.now(), statut: 'a_chercher', priorite: 2 });
      await saveWishlist();
      done.push(`Ajouté aux achats : ${a.nom}`);
      return { ok: true };
    },
  };
  return {
    done, undo,
    execute: async (name, args) => (tools[name] ? tools[name](args) : { erreur: `outil inconnu : ${name}` }),
  };
}

async function undoChatActions(m) {
  for (const u of [...(m.undo || [])].reverse()) {
    if (u.kind === 'item' && u.before) await saveItem(structuredClone(u.before));
    if (u.kind === 'week') { if (u.before) await db.put('weeks', structuredClone(u.before)); else await db.del('weeks', u.key); scheduleAutoBackup(); }
    if (u.kind === 'profile') { state.profile = structuredClone(u.before || {}); await db.setKV('profile', state.profile); scheduleAutoBackup(); }
    if (u.kind === 'wishlist') { state.wishlist = structuredClone(u.before || []); await saveWishlist(); }
  }
  m.undone = true; delete m.undo;
  await db.put('chat', m);
}

/* =========================================================== ACHATS */
function wishlistSection() {
  const list = state.wishlist.filter(w => w.statut !== 'ignore');
  const open = list.filter(w => w.statut !== 'achete');
  const bought = list.filter(w => w.statut === 'achete');
  const note = h('input', { type: 'text', placeholder: 'Précision (facultatif) : ex. un pull pour l’hiver, budget 40 €' });
  const btn = button(open.length ? 'Mettre à jour la liste' : 'Que me manque-t-il ?', { ic: 'auto_awesome', cls: 'wide', disabled: !state.settings.apiKey || state.items.length < 3,
    onclick: async () => {
      btn.disabled = true; card.append(loader('Le styliste passe ta garde-robe en revue…'));
      try {
        const weeks = await db.all('weeks');
        const context = wardrobeContext({ profile: state.profile, items: state.items, weeks, today: today() });
        const { articles, bilan } = await recommendPurchases({ settings: state.settings, context, wishlist: state.wishlist, note: note.value.trim() });
        const now = Date.now();
        state.wishlist = state.wishlist.filter(w => w.statut !== 'a_chercher').concat(articles.map((a, i) => ({ ...a, id: 'w' + now + i, statut: 'a_chercher' })));
        state.wishlistBilan = bilan;
        await db.setKV('wishlistBilan', bilan);
        await saveWishlist();
        snackbar(`${articles.length} pièce${articles.length > 1 ? 's' : ''} à chercher`);
      } catch (e) { snackbar(errorText(e), { duration: 7000 }); }
      rerender();
    } });
  const prio = { 1: ['Indispensable', 'priority_high'], 2: ['Utile', 'thumb_up'], 3: ['Plaisir', 'favorite'] };
  const row = (w) => h('article', { class: 'wish' + (w.statut === 'achete' ? ' done' : '') },
    h('div', { class: 'wish-head' },
      h('div', {}, h('strong', {}, w.nom), h('small', { class: 'muted' }, [w.categorie, w.taille && 'taille ' + w.taille, w.budget].filter(Boolean).join(' · '))),
      h('span', { class: 'badge inline p' + w.priorite }, icon(prio[w.priorite][1]), prio[w.priorite][0])),
    w.pourquoi ? h('p', { class: 'small' }, w.pourquoi) : null,
    w.criteres ? h('p', { class: 'small muted' }, icon('checklist', 'tiny'), ' ', w.criteres) : null,
    w.statut === 'achete' ? null : h('div', { class: 'row wrap' },
      w.motsClesVinted ? button('Mots-clés Vinted', { kind: 'tonal', ic: 'content_copy', onclick: () => copyText(w.motsClesVinted) }) : null,
      button('Juger une trouvaille', { kind: 'text', ic: 'forum', onclick: () => {
        sharedText = `J’ai trouvé ceci pour « ${w.nom} ». Est-ce que ça convient (style, matière, taille ${w.taille || ''}) ?`;
        location.hash = '#/styliste';
      } }),
      button('Acheté', { kind: 'text', ic: 'check', onclick: async () => {
        w.statut = 'achete'; w.dateAchat = today(); await saveWishlist(); rerender();
        openItemEditor(null, { preset: { nom: w.nom, categorie: CATEGORIES[w.categorie] ? w.categorie : 'Haut (autre)', taille: w.taille }, afterSave: () => rerender() });
      } }),
      iconButton('close', 'Retirer', async () => { w.statut = 'ignore'; await saveWishlist(); rerender(); })));
  const card = h('section', { class: 'card' },
    h('h3', {}, icon('shopping_bag'), ' À acheter'),
    h('p', { class: 'muted small' }, 'Le styliste cherche ce qui compléterait le mieux ta garde-robe, puis te donne quoi taper sur Vinted et quoi vérifier.'),
    h('label', { class: 'field' }, note), btn,
    state.wishlistBilan ? h('p', { class: 'small' }, cleanAI(state.wishlistBilan)) : null,
    open.length ? h('div', { class: 'wishes' }, open.sort((a, b) => a.priorite - b.priorite).map(row)) : null,
    bought.length ? h('details', {}, h('summary', {}, `Achetées (${bought.length})`), bought.map(row)) : null);
  return card;
}

/* =========================================================== TRI & VENTE */
function renderTri() {
  const v = view();
  const kept = state.items.filter(i => i.statut === 'garde');
  const forSale = state.items.filter(i => ['a_vendre', 'en_vente'].includes(i.statut));
  const sold = state.items.filter(i => i.statut === 'vendu');
  const gains = sold.reduce((s, i) => s + (Number(i.prixVente) || 0), 0);

  v.append(h('div', { class: 'stats' },
    stat(kept.length, 'gardées'), stat(forSale.length, 'à vendre'), stat(sold.length, 'vendues'), stat(gains + ' €', 'gagnés')));

  if (!state.settings.apiKey) v.append(needKeyCard());

  // Analyse
  const triCard = h('section', { class: 'card' },
    h('h3', {}, icon('rule'), ' Faire le tri'),
    h('p', {}, 'L’IA compare chaque pièce à tes goûts, à tes mensurations et à son utilité dans tes tenues, puis te dit quoi garder ou vendre.'),
    !state.profile.style && !state.profile.tailleCm ? h('p', { class: 'warn small' }, icon('info', 'tiny'), ' Remplis d’abord ton profil (mensurations et goûts) pour un tri pertinent.') : null);
  const triBtn = button(state.tri ? 'Nouvelle analyse par Gemini' : 'Analyser ma garde-robe', {
    kind: state.tri?.source === 'claude' ? 'outlined' : 'filled',
    ic: 'auto_awesome', cls: 'wide', disabled: !state.settings.apiKey || kept.length < 3,
    onclick: async () => {
      if (state.tri?.source === 'claude' && !(await confirmBox('Remplacer le tri de Claude par une nouvelle analyse de Gemini ? Les décisions déjà prises restent appliquées à tes pièces.', { ok: 'Remplacer' }))) return;
      triBtn.disabled = true;
      triCard.append(loader('Analyse de toutes tes pièces…'));
      try {
        state.tri = await triWardrobe({ settings: state.settings, profile: state.profile, items: state.items });
        state.tri.count = kept.length;
        state.tri.traites = [];
        await db.setKV('tri', state.tri);
        snackbar('Analyse terminée');
      } catch (e) { snackbar(errorText(e), { duration: 7000 }); }
      rerender();
    },
  });
  triCard.append(triBtn);
  if (state.tri) {
    const todo = trialList().filter(x => !x.done).length;
    triCard.append(button(todo ? `Mode essayage (${todo} à décider)` : 'Mode essayage', { kind: 'tonal', ic: 'checkroom', cls: 'wide', onclick: openTrialMode }));
  }
  if (kept.length < 3) triCard.append(h('p', { class: 'muted small' }, 'Ajoute au moins 3 pièces pour lancer l’analyse.'));
  v.append(triCard);

  if (state.tri) v.append(triResults());

  // Ventes
  v.append(h('h2', { class: 'section-head' }, 'Mes achats'));
  v.append(wishlistSection());
  v.append(h('h2', { class: 'section-head' }, 'Mes ventes'));
  if (!forSale.length) v.append(h('p', { class: 'muted' }, 'Aucune pièce à vendre pour l’instant.'));
  forSale.forEach(i => v.append(saleRow(i)));
  if (sold.length) {
    v.append(h('details', { class: 'card' }, h('summary', {}, `Vendues (${sold.length})`),
      sold.map(i => h('div', { class: 'list-row' }, zoomThumb(i, 'small'),
        h('div', { class: 'grow' }, h('strong', {}, i.nom), h('small', { class: 'muted' }, i.dateVente ? fmtDay(i.dateVente, { day: 'numeric', month: 'short', year: 'numeric' }) : '')),
        h('strong', {}, (i.prixVente ?? '?') + ' €')))));
  }
}

const stat = (n, l) => h('div', { class: 'stat' }, h('strong', {}, n), h('span', {}, l));

function triResults() {
  const tri = state.tri;
  const all = trialList();
  const essayer = all.filter(x => x.plan.essai && !x.done).length;
  const sortir = all.filter(x => !x.plan.essai && !x.done).length;
  const items = byId();
  const keep = tri.articles.filter(a => !trialPlan(a) && items[a.id]).length;

  // Repliable : l'en-tête rappelle qui a fait le tri, la date et ce qui reste ; l'état ouvert/fermé est mémorisé.
  const nb = tri.count || tri.articles.length;
  const d = new Date(tri.date);
  const when = fmtDay(tri.date.slice(0, 10), { day: 'numeric', month: 'long' }) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const reste = [essayer ? `${essayer} à essayer` : '', sortir ? `${sortir} à sortir` : ''].filter(Boolean).join(' · ') || 'tout est décidé';
  const details = h('details', { class: 'card tri-result', open: tri.open !== false,
    ontoggle: () => { if (tri.open !== details.open) { tri.open = details.open; db.setKV('tri', tri); } } },
    h('summary', {},
      h('span', { class: 'tri-sum-title' }, icon('history'), ` ${tri.source === 'claude' ? 'Tri de Claude' : 'Analyse'} du ${when}`),
      h('span', { class: 'tri-sum-meta' }, `${nb} pièce${nb > 1 ? 's' : ''} · ${reste}`),
      icon('expand_more', 'tri-chevron')),
    tri.bilan ? h('p', {}, cleanAI(tri.bilan)) : null,
    tri.manques?.length ? h('div', {}, h('h4', {}, 'Ce qui te manque'), h('ul', {}, tri.manques.map(m => h('li', {}, cleanAI(m))))) : null,
    h('p', { class: 'muted small' }, `${keep} pièce${keep > 1 ? 's' : ''} à garder sans rien faire. Le reste se règle dans le mode essayage.`));
  return details;
}

/* ---------- Mode essayage : décider pièce par pièce, le statut change tout de suite ---------- */
const TRIAL = {
  keep: { label: 'Gardées', ic: 'favorite', cls: 'trial-keep' },
  sell: { label: 'À vendre', ic: 'sell', cls: 'trial-sell' },
  give: { label: 'À donner', ic: 'volunteer_activism', cls: 'trial-give' },
  bin: { label: 'Bac textile', ic: 'recycling', cls: 'trial-bin' },
};
const TRIAL_ORDER = ['bas', 'maille', 'haut', 'dessus', 'chaussures', 'accessoire'];

// Ce qu'on fait d'une pièce d'après le tri. Deux formats : celui de Claude (garder / essayer / vendre / donner / bac,
// avec siNonVa pour les pièces à essayer) et l'ancien format de Gemini (garder / verifier / vendre).
const SORTIE = { vendre: 'sell', donner: 'give', bac: 'bin' };
const SORTIE_TXT = { sell: 'à vendre', give: 'à donner', bin: 'au bac textile' };
function trialPlan(a) {
  const d = a.decision;
  if (d === 'essayer' || d === 'verifier') return { essai: true, sortie: SORTIE[a.siNonVa] || 'give' };
  if (SORTIE[d]) return { essai: false, sortie: SORTIE[d] };
  return null;   // garder
}

// Pièces à essayer ou à sortir, avec la décision déjà prise pendant l'essayage.
function trialList() {
  const tri = state.tri;
  if (!tri?.articles) return [];
  const items = byId();
  const essai = tri.essai || {};
  return tri.articles
    .filter(a => items[a.id] && trialPlan(a))
    .filter(a => essai[a.id] || items[a.id].statut === 'garde')
    .map(a => ({ a, it: items[a.id], plan: trialPlan(a), dec: essai[a.id]?.dec || null, done: !!essai[a.id] }))
    .sort((x, y) => (y.plan.essai - x.plan.essai));
}

async function applyTrial(id, dec) {
  const tri = state.tri;
  tri.essai ||= {};
  const it = byId()[id];
  if (!it) return;
  const prev = tri.essai[id];
  // On repart toujours de l'état d'avant l'essayage, pour pouvoir changer d'avis ou annuler.
  if (prev) { it.statut = prev.before.statut; it.notes = prev.before.notes; }
  const traites = new Set(tri.traites || []);
  if (!dec || prev?.dec === dec) {
    delete tri.essai[id];
    if (!prev?.wasTraite) traites.delete(id);
  } else {
    const before = prev?.before || { statut: it.statut, notes: it.notes || '' };
    const wasTraite = prev ? prev.wasTraite : traites.has(id);
    const d = fmtDay(today(), { day: '2-digit', month: '2-digit' });
    const extra = { keep: `Essayé le ${d} : va.`, give: `Donné le ${d}.`, bin: `Mis au bac textile le ${d}.`, sell: '' }[dec];
    it.statut = { keep: 'garde', sell: 'a_vendre', give: 'donne', bin: 'donne' }[dec];
    it.notes = extra ? [before.notes.trim(), extra].filter(Boolean).join(' ') : before.notes;
    tri.essai[id] = { dec, before, wasTraite };
    traites.add(id);
  }
  tri.traites = [...traites];
  await saveItem(it);
  await db.setKV('tri', tri);
}

function openTrialMode() {
  let hideDone = false;
  const counter = h('p', { class: 'trial-count' });
  const tallies = h('div', { class: 'chips' });
  const list = h('div', { class: 'trial-list' });
  const hideChip = h('button', { type: 'button', class: 'chip', onclick: () => { hideDone = !hideDone; paint(); } });

  const row = (x) => {
    const meta = [x.it.marque, x.it.taille].filter(Boolean).join(' · ');
    const { essai, sortie } = x.plan;
    const consigne = essai ? 'Essaie-le.' : `Pas besoin d’essayer : ${SORTIE_TXT[sortie]}.`;
    const choices = essai
      ? [['keep', 'Ça me va'], [sortie, 'Ne va pas : ' + SORTIE_TXT[sortie]]]
      : [[sortie, 'OK, ' + SORTIE_TXT[sortie]], ['keep', 'Je le garde']];
    return h('article', { class: 'trial-row' + (x.dec ? ' ' + TRIAL[x.dec].cls : ''), 'data-id': x.it.id },
      h('div', { class: 'list-row' }, zoomThumb(x.it, 'small'),
        h('div', { class: 'grow' }, h('strong', {}, x.it.nom), meta ? h('small', { class: 'muted' }, meta) : null,
          h('p', { class: 'trial-todo' }, consigne),
          x.a.raison ? h('p', { class: 'small muted' }, cleanAI(x.a.raison)) : null)),
      h('div', { class: 'chips trial-chips' }, choices.map(([k, label]) =>
        h('button', { type: 'button', class: 'chip ' + TRIAL[k].cls + (x.dec === k ? ' on' : ''), 'aria-pressed': String(x.dec === k),
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await applyTrial(x.it.id, k); } catch (err) { snackbar(errorText(err)); }
            paint();
          } }, icon(x.dec === k ? 'check' : TRIAL[k].ic), label))));
  };

  function paint() {
    const all = trialList();
    const done = all.filter(x => x.done);
    counter.textContent = `${done.length} / ${all.length} pièces décidées`;
    fill(tallies, Object.entries(TRIAL).map(([k, t]) => {
      const n = done.filter(x => x.dec === k).length;
      return h('span', { class: 'chip trial-tally ' + t.cls }, icon(t.ic), `${t.label} ${n}`);
    }));
    fill(hideChip, icon(hideDone ? 'visibility' : 'visibility_off'), hideDone ? 'Montrer les pièces décidées' : 'Cacher les pièces décidées');
    const shown = hideDone ? all.filter(x => !x.done) : all;
    const groups = TRIAL_ORDER.map(g => [g, shown.filter(x => groupOf(x.it.categorie) === g)]).filter(([, l]) => l.length);
    fill(list, groups.length ? groups.map(([g, l]) => {
      const total = all.filter(x => groupOf(x.it.categorie) === g);
      return h('section', { class: 'trial-group' },
        h('h3', {}, icon(GROUPS[g].icon), ` ${GROUPS[g].label}`, h('span', { class: 'muted small' }, ` ${total.filter(x => x.done).length}/${total.length}`)),
        l.map(row));
    }) : h('p', { class: 'muted' }, all.length ? 'Tout est décidé. Bravo !' : 'Aucune pièce à essayer dans cette analyse.'));
  }

  const body = h('div', { class: 'trial' },
    h('p', { class: 'small' }, 'Pour chaque pièce, fais ce qui est écrit et appuie sur l’un des deux boutons : le statut change tout de suite. Si tu t’es trompé, touche de nouveau le même bouton pour annuler.'),
    counter, tallies, hideChip, list);
  paint();
  fullDialog({ title: 'Mode essayage', body, onClose: () => rerender() });
}

function saleRow(item) {
  const a = item.annonce;
  return h('article', { class: 'card sale' },
    h('div', { class: 'list-row' }, zoomThumb(item, 'small'),
      h('div', { class: 'grow' }, h('strong', {}, item.nom),
        h('span', { class: 'badge inline' }, icon(STATUTS[item.statut].icon), STATUTS[item.statut].label),
        a?.prix ? h('p', { class: 'small' }, `Prix conseillé : ${a.prix} €`) : null)),
    h('div', { class: 'row wrap end' },
      button(a ? 'Voir l’annonce' : 'Préparer l’annonce', { kind: a ? 'tonal' : 'filled', ic: 'description', onclick: () => openListing(item) })));
}

/* ------------------------------------------- Annonce Vinted */
async function openListing(item) {
  const body = h('div', { class: 'listing' });
  const missing = MEASURES[groupOf(item.categorie)].filter(([k]) => !item.mesures?.[k]);
  const layer = fullDialog({ title: 'Annonce Vinted', body });

  const searchToggle = h('input', { type: 'checkbox', checked: state.settings.searchPrices,
    onchange: () => { state.settings.searchPrices = searchToggle.checked; saveSettings(); } });

  async function generate() {
    body.replaceChildren(loader('Rédaction de l’annonce et estimation du prix…'));
    try {
      const photos = [];
      for (const pid of (item.photoIds || []).slice(0, 3)) { const p = await db.get('photos', pid); if (p) photos.push(p.blob); }
      item.annonce = await makeListing({ settings: state.settings, item, photoBlobs: photos, search: state.settings.searchPrices });
      await saveItem(item);
      paint();
    } catch (e) {
      body.replaceChildren(h('p', { class: 'err' }, errorText(e)), button('Réessayer', { ic: 'refresh', onclick: generate }));
    }
  }

  function paint() {
    const a = item.annonce;
    body.replaceChildren();
    add(body, h('div', { class: 'list-row' }, zoomThumb(item, 'small'), h('div', { class: 'grow' }, h('strong', {}, item.nom), h('small', { class: 'muted' }, [item.marque, item.taille].filter(Boolean).join(' · ')))));
    if (missing.length) {
      add(body, h('div', { class: 'card warn-card' },
        h('p', {}, icon('straighten', 'tiny'), ` Mesures à plat manquantes : ${missing.map(m => m[1].toLowerCase()).join(', ')}. Les acheteurs les demandent presque toujours.`),
        button('Saisir les mesures', { kind: 'tonal', ic: 'edit', onclick: () => { layer.close(); setTimeout(() => openItemEditor(item, { afterSave: (it) => openListing(it) }), 300); } })));
    }
    if (!a) {
      add(body, 
        h('label', { class: 'switch-row' }, searchToggle, h('span', {}, 'Chercher des prix comparables en ligne (recherche Google via Gemini)')),
        button('Générer l’annonce', { ic: 'auto_awesome', cls: 'wide', disabled: !state.settings.apiKey, onclick: generate }),
        !state.settings.apiKey ? needKeyCard() : null);
      return;
    }
    const titleIn = h('input', { type: 'text', maxlength: 50, value: a.titre, oninput: () => { a.titre = titleIn.value; counter.textContent = `${a.titre.length}/50`; persist(); } });
    const counter = h('em', {}, `${a.titre.length}/50`);
    const descIn = h('textarea', { rows: 12, oninput: () => { a.description = descIn.value; persist(); } });
    descIn.value = a.description;
    const persist = debounce(() => saveItem(item), 500);

    add(body, 
      h('section', { class: 'price' },
        h('span', { class: 'muted small' }, 'Prix conseillé'),
        h('strong', {}, a.prix != null ? `${a.prix} €` : '—'),
        a.prixMin != null && a.prixMax != null ? h('span', {}, `fourchette ${a.prixMin} – ${a.prixMax} €`) : null,
        a.justificationPrix ? h('p', { class: 'small' }, a.justificationPrix) : null,
        h('p', { class: 'muted small' }, a.rechercheEnLigne ? 'Estimation appuyée sur une recherche en ligne.' : 'Estimation de l’IA sans recherche en ligne : vérifie 2 ou 3 annonces similaires sur Vinted avant de publier.'),
        a.sources?.length ? h('details', {}, h('summary', {}, `Sources (${a.sources.length})`),
          h('ul', {}, a.sources.filter(s => /^https:\/\//i.test(s.uri || '')).slice(0, 8).map(s => h('li', {}, h('a', { href: s.uri, target: '_blank', rel: 'noopener noreferrer' }, s.title))))) : null),
      h('label', { class: 'field' }, h('span', {}, 'Titre ', counter), h('div', { class: 'with-action' }, titleIn, iconButton('content_copy', 'Copier le titre', () => copyText(a.titre)))),
      a.titreTronque ? h('p', { class: 'muted small' }, 'Titre raccourci à 50 caractères (limite Vinted).') : null,
      h('label', { class: 'field' }, h('span', {}, 'Description'), descIn),
      h('div', { class: 'row wrap' },
        button('Copier la description', { kind: 'tonal', ic: 'content_copy', onclick: () => copyText(a.description) }),
        navigator.share ? button('Partager', { kind: 'outlined', ic: 'share', onclick: () => shareListing(item) }) : null),
      h('h3', { class: 'section-title' }, 'À remplir dans Vinted'),
      h('div', { class: 'kv' }, [['Catégorie', a.categorieVinted], ['Marque', a.marque], ['Taille', a.taille], ['État', a.etat],
        ['Couleurs', (a.couleurs || []).join(', ')], ['Matière', a.matiere]].filter(([, val]) => val).map(([k, val]) =>
        h('button', { class: 'kv-row', type: 'button', onclick: () => copyText(val) }, h('span', {}, k), h('strong', {}, val), icon('content_copy', 'tiny')))),
      a.photosAFaire?.length ? [h('h3', { class: 'section-title' }, 'Photos à prendre'),
        h('ul', { class: 'checklist' }, a.photosAFaire.map(p => h('li', {}, h('label', {}, h('input', { type: 'checkbox' }), ' ', p))))] : null,
      a.mesuresManquantes?.length ? h('p', { class: 'warn small' }, 'Mesures conseillées : ' + a.mesuresManquantes.join(', ')) : null,
      a.conseils ? h('p', { class: 'small' }, icon('lightbulb', 'tiny'), ' ', a.conseils) : null,
      h('h3', { class: 'section-title' }, 'Suivi'),
      h('div', { class: 'row wrap' },
        item.statut === 'a_vendre' ? button('Je l’ai mise en ligne', { kind: 'tonal', ic: 'storefront', onclick: async () => {
          item.statut = 'en_vente'; item.dateMiseEnLigne = today(); await saveItem(item); snackbar('Marquée en ligne'); layer.close(); rerender();
        } }) : null,
        button('Vendue', { kind: 'filled', ic: 'paid', onclick: async () => {
          const p = await promptBox('Prix de vente final', { value: a.prix ?? '', type: 'number', suffix: '€' });
          if (p == null) return;
          item.statut = 'vendu'; item.prixVente = Number(String(p).replace(',', '.')) || 0; item.dateVente = today();
          await saveItem(item); snackbar('Bravo pour la vente !'); layer.close(); rerender();
        } }),
        button('Regénérer', { kind: 'text', ic: 'refresh', onclick: generate }),
        button('Retirer de la vente', { kind: 'text', ic: 'undo', onclick: async () => {
          item.statut = 'garde'; await saveItem(item); layer.close(); rerender();
        } })));
  }
  paint();
}

async function shareListing(item) {
  const a = item.annonce;
  const files = [];
  for (const [i, pid] of (item.photoIds || []).entries()) {
    const p = await db.get('photos', pid);
    if (p) files.push(new File([p.blob], `photo-${i + 1}.jpg`, { type: 'image/jpeg' }));
  }
  const text = `${a.titre}\n\n${a.description}\n\nPrix : ${a.prix} €`;
  try {
    if (files.length && navigator.canShare?.({ files })) await navigator.share({ files, text, title: a.titre });
    else await navigator.share({ text, title: a.titre });
  } catch (e) { if (e?.name !== 'AbortError') copyText(text); }
}

/* =========================================================== PROFIL */
function renderProfil() {
  const v = view();
  const p = state.profile;
  const s = state.settings;
  const numField = ([k, l]) => {
    const inp = h('input', { type: 'text', inputmode: k.startsWith('t') && k !== 'tailleCm' && k !== 'tourTaille' ? 'text' : 'decimal', value: p[k] ?? '',
      oninput: () => { p[k] = inp.value.trim(); saveProfile(); } });
    return h('label', { class: 'field' }, h('span', {}, l), inp);
  };

  v.append(h('section', { class: 'card' },
    h('h3', {}, icon('straighten'), ' Mensurations (cm)'),
    h('p', { class: 'muted small' }, 'Sert au tri (ce qui te va ou non). Mesure sans serrer, en sous-vêtements.'),
    h('div', { class: 'two' }, PROFILE_MEASURES.map(numField)),
    h('h4', {}, 'Tailles habituelles'),
    h('div', { class: 'two' }, PROFILE_SIZES.map(numField))));

  const formOut = h('em', {}, FORMALITE[p.formaliteHabituelle || 3]);
  const formRange = h('input', { type: 'range', min: 1, max: 5, value: p.formaliteHabituelle || 3,
    oninput: () => { p.formaliteHabituelle = Number(formRange.value); formOut.textContent = FORMALITE[p.formaliteHabituelle]; saveProfile(); } });
  v.append(h('section', { class: 'card' },
    h('h3', {}, icon('palette'), ' Mes goûts'),
    h('p', { class: 'muted small' }, 'Écris librement, comme à un styliste. Plus c’est précis, mieux c’est.'),
    PROFILE_TASTES.map(([k, l, ph]) => {
      const ta = h('textarea', { rows: 2, placeholder: ph, oninput: () => { p[k] = ta.value; saveProfile(); } });
      ta.value = p[k] || '';
      return h('label', { class: 'field' }, h('span', {}, l), ta);
    }),
    h('label', { class: 'field' }, h('span', {}, 'Formalité habituelle : ', formOut), formRange)));

  // Réglages IA
  const keyIn = h('input', { type: 'password', value: s.apiKey, autocomplete: 'off', placeholder: 'AIza…', spellcheck: 'false',
    oninput: () => { s.apiKey = keyIn.value.trim(); saveSettings(); } });
  const modelSel = h('select', { onchange: () => { s.model = modelSel.value === '__custom' ? s.model : modelSel.value; saveSettings(); paintCustom(); } },
    MODELS.map(([id, l]) => h('option', { value: id, selected: s.model === id ? 'selected' : null }, l)),
    h('option', { value: '__custom', selected: MODELS.some(m => m[0] === s.model) ? null : 'selected' }, 'Autre modèle…'));
  const customWrap = h('div', {});
  function paintCustom() {
    if (modelSel.value !== '__custom') { customWrap.replaceChildren(); return; }
    const c = h('input', { type: 'text', value: s.model, placeholder: 'ex. gemini-flash-latest', oninput: () => { s.model = c.value.trim(); saveSettings(); } });
    customWrap.replaceChildren(h('label', { class: 'field' }, h('span', {}, 'Identifiant du modèle'), c));
  }
  paintCustom();
  const testOut = h('p', { class: 'small' });
  v.append(h('section', { class: 'card' },
    h('h3', {}, icon('auto_awesome'), ' Intelligence artificielle'),
    h('label', { class: 'field' }, h('span', {}, 'Clé API Gemini'),
      h('div', { class: 'with-action' }, keyIn, iconButton('visibility', 'Afficher', () => { keyIn.type = keyIn.type === 'password' ? 'text' : 'password'; }))),
    h('p', { class: 'small' }, h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Créer une clé gratuite sur Google AI Studio'),
      ' (connecte-toi avec ton compte Google, « Create API key », puis colle-la ici).'),
    h('label', { class: 'field' }, h('span', {}, 'Modèle'), modelSel), customWrap,
    h('label', { class: 'switch-row' },
      (() => { const c = h('input', { type: 'checkbox', checked: s.searchPrices, onchange: () => { s.searchPrices = c.checked; saveSettings(); } }); return c; })(),
      h('span', {}, 'Annonces : chercher des prix comparables en ligne')),
    h('div', { class: 'row wrap' }, button('Tester la clé', { kind: 'tonal', ic: 'network_check', onclick: async () => {
      testOut.className = 'small'; testOut.textContent = 'Test en cours…';
      try {
        const { json } = await callGemini({ settings: s, parts: [{ text: 'Réponds {"ok":"oui"}' }],
          schema: { type: 'OBJECT', properties: { ok: { type: 'STRING' } }, required: ['ok'] } });
        testOut.className = 'small ok'; testOut.textContent = `Ça marche (${s.model}) : ${JSON.stringify(json)}`;
      } catch (e) { testOut.className = 'small err'; testOut.textContent = errorText(e); }
    } })),
    testOut,
    h('p', { class: 'muted small' }, 'Avec l’offre gratuite, Google peut utiliser les contenus envoyés (photos, fiches, goûts) pour améliorer ses modèles, et des personnes peuvent les relire. N’envoie rien de plus personnel que nécessaire.')));

  // Météo
  const lieuOut = h('strong', {}, s.lieu.name);
  const results = h('div', { class: 'pick-list' });
  const q = h('input', { type: 'search', placeholder: 'Chercher une ville' });
  const chooseLieu = (l) => { s.lieu = l; saveSettings(); lieuOut.textContent = l.name; results.replaceChildren(); q.value = ''; snackbar('Lieu météo : ' + l.name); };
  v.append(h('section', { class: 'card' },
    h('h3', {}, icon('partly_cloudy_day'), ' Météo'),
    h('p', {}, 'Lieu utilisé : ', lieuOut),
    h('div', { class: 'with-action' }, q, iconButton('search', 'Chercher', async () => {
      if (!q.value.trim()) return;
      results.replaceChildren(loader());
      try {
        const r = await geocode(q.value.trim());
        results.replaceChildren(...(r.length ? r.map(l => h('button', { class: 'pick', type: 'button', onclick: () => chooseLieu(l) },
          icon('location_on'), h('span', {}, h('strong', {}, l.name), h('small', {}, l.detail)))) : [h('p', { class: 'muted' }, 'Aucun résultat.')]));
      } catch (e) { results.replaceChildren(h('p', { class: 'err small' }, e.message)); }
    })),
    results,
    button('Utiliser ma position', { kind: 'text', ic: 'my_location', onclick: () => {
      if (!navigator.geolocation) return snackbar('Géolocalisation indisponible');
      navigator.geolocation.getCurrentPosition(
        (pos) => chooseLieu({ name: 'Ma position', detail: '', lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) }),
        () => snackbar('Position refusée ou indisponible'), { timeout: 10000 });
    } })));

  // Apparence
  const setSeed = (hex) => { s.seedColor = hex; saveSettings(); applyTheme(); rerender(); };
  const swatch = (hex, label) => h('button', { type: 'button', class: 'swatch' + (s.seedColor?.toLowerCase() === hex.toLowerCase() ? ' on' : ''),
    style: `--sw:${hex}`, title: label || hex, 'aria-label': label || `Couleur ${hex}`, onclick: () => setSeed(hex) },
    s.seedColor?.toLowerCase() === hex.toLowerCase() ? icon('check') : null);
  const wallIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const seeds = await seedsFromImage(f);
      if (!seeds.length) throw new Error('aucune couleur trouvée');
      s.wallpaperSeeds = seeds; s.seedColor = seeds[0]; saveSettings(); applyTheme(); rerender();
      snackbar('Couleurs reprises de ton fond d’écran');
    } catch (err) { snackbar('Image illisible : ' + err.message); }
  } });
  const custom = h('input', { type: 'color', value: s.seedColor || DEFAULT_SEED, 'aria-label': 'Couleur personnalisée',
    onchange: () => setSeed(custom.value) });
  v.append(h('section', { class: 'card' },
    h('h3', {}, icon('palette'), ' Couleurs et thème'),
    h('div', { class: 'segmented' }, [['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) =>
      h('button', { type: 'button', class: s.theme === k ? 'on' : '', onclick: () => { s.theme = k; saveSettings(); applyTheme(); rerender(); } },
        s.theme === k ? icon('check') : null, l))),
    h('p', { class: 'small' }, 'Pour reprendre les couleurs de ton Pixel : fais une capture de ton écran d’accueil (ou de ton fond d’écran), puis choisis-la ici. L’appli applique le même calcul Material You qu’Android.'),
    button('Depuis mon fond d’écran', { kind: 'tonal', ic: 'wallpaper', cls: 'wide', onclick: () => wallIn.click() }), wallIn,
    s.wallpaperSeeds?.length ? [h('h4', {}, 'Tirées de ton fond d’écran'), h('div', { class: 'swatches' }, s.wallpaperSeeds.map(c => swatch(c)))] : null,
    h('h4', {}, 'Autres couleurs'),
    h('div', { class: 'swatches' }, PRESETS.map(c => swatch(c)),
      h('label', { class: 'swatch custom', title: 'Couleur personnalisée' }, icon('colorize'), custom))));

  // Données
  v.append(driveCard());
  const importIn = h('input', { type: 'file', accept: '.json,application/json,text/plain', hidden: true, onchange: (e) => importBackup(e.target.files[0]) });
  const profIn = h('input', { type: 'file', accept: '.json,application/json,text/plain', hidden: true, onchange: (e) => importProfile(e.target.files[0]) });
  v.append(h('section', { class: 'card' },
    h('h3', {}, icon('database'), ' Mes données'),
    h('p', { class: 'muted small' }, `Tout est stocké sur ce téléphone (${state.items.length} pièces).`),
    h('div', { class: 'row wrap' },
      button('Fichier de sauvegarde', { kind: 'tonal', ic: 'download', onclick: () => exportBackup(false) }),
      button('Restaurer un fichier', { kind: 'outlined', ic: 'upload', onclick: () => importIn.click() }), importIn,
      button('Importer un profil ou un tri', { kind: 'outlined', ic: 'person_add', onclick: () => profIn.click() }), profIn),
    button('Tout effacer', { kind: 'text', ic: 'delete_forever', cls: 'danger-text', onclick: wipeAll })));
  v.append(h('p', { class: 'muted small center' }, 'Garde-robe · v1.2'));
}

/* ------------------------------------------- Sauvegarde (fichier et Google Drive) */
const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
// Décodage local (sans fetch : la politique de sécurité de la page interdit fetch sur les URL data:).
const dataURLToBlob = async (u) => {
  const i = u.indexOf(',');
  const meta = u.slice(5, i);
  const type = meta.split(';')[0] || 'application/octet-stream';
  if (!/;base64/i.test(meta)) return new Blob([decodeURIComponent(u.slice(i + 1))], { type });
  const bin = atob(u.slice(i + 1));
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new Blob([bytes], { type });
};

async function backupJSON() {
  const photos = await db.all('photos');
  const chat = await db.all('chat');
  return JSON.stringify({
    app: 'garde-robe', version: 2, exportedAt: new Date().toISOString(),
    seq: await db.getKV('seq'), items: await db.all('items'), weeks: await db.all('weeks'),
    profile: state.profile, tri: state.tri, wishlist: state.wishlist, wishlistBilan: state.wishlistBilan || '',
    settings: { ...state.settings, apiKey: '' },
    photos: await Promise.all(photos.map(async p => ({ id: p.id, itemId: p.itemId, thumb: p.thumb, data: await blobToDataURL(p.blob) }))),
    chat: await Promise.all(chat.map(async m => ({ ...m, images: await Promise.all((m.images || []).map(async i => ({ thumb: i.thumb, data: await blobToDataURL(i.blob) }))) }))),
  });
}

async function exportBackup(share) {
  snackbar('Préparation de la sauvegarde…');
  const json = await backupJSON();
  const name = `garde-robe-${today()}.json`;
  if (share) {
    for (const type of ['application/json', 'text/plain']) {
      const file = new File([json], type === 'text/plain' ? name.replace('.json', '.txt') : name, { type });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Sauvegarde garde-robe' }); return; }
        catch (e) { if (e?.name === 'AbortError') return; }
      }
    }
    snackbar('Partage de fichier impossible ici : téléchargement à la place.');
  }
  const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function restoreFromJSON(text, { confirm = true } = {}) {
  const data = JSON.parse(text);
  if (data.app !== 'garde-robe' || !Array.isArray(data.items)) throw new Error('Ce fichier n’est pas une sauvegarde de garde-robe.');
  if (confirm && !(await confirmBox(`Restaurer ${data.items.length} pièces ? Les données actuelles de ce téléphone seront remplacées.`, { ok: 'Restaurer', danger: true }))) return false;
  const photos = await Promise.all((data.photos || []).map(async p => ({ id: p.id, itemId: p.itemId, thumb: p.thumb, blob: await dataURLToBlob(p.data) })));
  const chat = await Promise.all((data.chat || []).map(async m => ({ ...m, images: await Promise.all((m.images || []).map(async i => ({ thumb: i.thumb, blob: await dataURLToBlob(i.data) }))) })));
  for (const st of ['items', 'photos', 'weeks', 'chat']) await db.clear(st);
  await db.putMany('items', data.items);
  await db.putMany('photos', photos);
  await db.putMany('weeks', data.weeks || []);
  await db.putMany('chat', chat);
  await db.setKV('seq', data.seq || data.items.length);
  await db.setKV('profile', data.profile || {});
  await db.setKV('tri', data.tri || null);
  await db.setKV('wishlist', data.wishlist || []);
  await db.setKV('wishlistBilan', data.wishlistBilan || '');
  await db.setKV('settings', { ...DEFAULT_SETTINGS, ...(data.settings || {}), apiKey: state.settings.apiKey, driveClientId: state.settings.driveClientId || data.settings?.driveClientId || '' });
  return true;
}

async function importBackup(file) {
  if (!file) return;
  try {
    if (await restoreFromJSON(await file.text())) { snackbar('Sauvegarde restaurée'); setTimeout(() => location.reload(), 600); }
  } catch (e) { snackbar(e.message || 'Restauration impossible', { duration: 6000 }); }
}

// Profil seul (fichier { app: 'garde-robe-profil', profile: {…} }) : fusion champ par champ, rien d'autre n'est touché.
async function importProfile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app === 'garde-robe-tri') return await importTri(data);
    const p = data.app === 'garde-robe-profil' ? data.profile : (data.app === 'garde-robe' ? data.profile : null);
    if (!p || typeof p !== 'object') throw new Error('Ce fichier ne contient pas de profil.');
    const n = Object.keys(p).filter(k => p[k] !== '' && p[k] != null).length;
    if (!(await confirmBox(`Importer ${n} champs de profil ? Les champs présents dans le fichier remplacent les tiens, les autres sont conservés.`, { ok: 'Importer' }))) return;
    for (const [k, val] of Object.entries(p)) if (val !== '' && val != null) state.profile[k] = val;
    await db.setKV('profile', state.profile);
    snackbar('Profil importé'); rerender();
  } catch (e) { snackbar(e.message || 'Import impossible', { duration: 6000 }); }
}

// Tri préparé à l'extérieur (fichier { app: 'garde-robe-tri', tri: {…} }) : remplace l'analyse, garde les décisions d'essayage déjà prises.
async function importTri(data) {
  const t = data.tri;
  if (!t || !Array.isArray(t.articles)) throw new Error('Ce fichier ne contient pas de tri.');
  const items = byId();
  const ok = new Set(['garder', 'essayer', 'vendre', 'donner', 'bac']);
  const articles = t.articles.filter(a => a && items[a.id] && ok.has(a.decision))
    .map(a => ({ id: a.id, decision: a.decision, siNonVa: a.siNonVa || '', raison: String(a.raison || '') }));
  if (!articles.length) throw new Error('Aucune pièce de ce tri ne correspond à ta garde-robe.');
  const n = (d) => articles.filter(a => a.decision === d).length;
  const msg = `Importer le tri de ${articles.length} pièces : ${n('essayer')} à essayer, ${n('vendre')} à vendre, ${n('donner')} à donner, ${n('bac')} au bac textile, ${n('garder')} à garder ? Il remplace l’analyse actuelle ; ce que tu as déjà décidé en essayage est conservé.`;
  if (!(await confirmBox(msg, { ok: 'Importer' }))) return;
  const old = state.tri || {};
  const ids = new Set(articles.map(a => a.id));
  const essai = Object.fromEntries(Object.entries(old.essai || {}).filter(([id]) => ids.has(id)));
  state.tri = {
    source: 'claude', articles, bilan: String(t.bilan || ''), manques: Array.isArray(t.manques) ? t.manques.map(String) : [],
    date: t.date || new Date().toISOString(), count: articles.length,
    traites: (old.traites || []).filter(id => essai[id]), essai, open: true,
  };
  await db.setKV('tri', state.tri);
  snackbar('Tri importé. Ouvre le mode essayage dans Tri & achats.', { duration: 6000 });
  rerender();
}

/* ---- Google Drive ---- */
let autoBackupTimer = null, lastAutoBackup = 0;
function scheduleAutoBackup() {
  if (!state.settings.driveAuto || !state.settings.driveClientId || !drive.isConnected()) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(async () => {
    try { await drive.upload(await backupJSON(), { auto: true }); lastAutoBackup = Date.now(); state.driveStatus = 'Sauvegarde automatique : ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); document.getElementById('driveStatus')?.replaceChildren(state.driveStatus); }
    catch (e) { state.driveStatus = 'Sauvegarde automatique échouée : ' + e.message; document.getElementById('driveStatus')?.replaceChildren(state.driveStatus); }
  }, 8000);
}

function driveCard() {
  const s = state.settings;
  const status = h('p', { class: 'small', id: 'driveStatus' }, state.driveStatus || (drive.isConnected() ? 'Connecté à Google Drive.' : 'Non connecté.'));
  const clientIn = h('input', { type: 'text', value: s.driveClientId, placeholder: '…apps.googleusercontent.com', spellcheck: 'false', autocomplete: 'off',
    oninput: () => { s.driveClientId = clientIn.value.trim(); saveSettings(); } });
  const autoCb = h('input', { type: 'checkbox', checked: s.driveAuto, onchange: () => { s.driveAuto = autoCb.checked; saveSettings(); } });
  const list = h('div', { class: 'pick-list' });
  const setStatus = (t, cls = 'small') => { status.className = cls; status.textContent = t; state.driveStatus = t; };
  const run = async (fn, busyText) => {
    setStatus(busyText);
    try { await fn(); } catch (e) { setStatus(e.message || String(e), 'small err'); }
  };
  const showList = async () => {
    fill(list, loader());
    const files = await drive.listBackups();
    fill(list, files.length ? files.map(f => h('div', { class: 'list-row' },
      icon('cloud'), h('div', { class: 'grow' }, h('strong', {}, f.name), h('small', { class: 'muted' }, new Date(f.modifiedTime).toLocaleString('fr-FR') + (f.size ? ` · ${Math.round(f.size / 1024)} ko` : ''))),
      iconButton('restore', 'Restaurer cette sauvegarde', () => run(async () => {
        const txt = await drive.download(f.id);
        if (await restoreFromJSON(txt)) { snackbar('Sauvegarde restaurée'); setTimeout(() => location.reload(), 600); } else setStatus('Restauration annulée.');
      }, 'Téléchargement…')),
      iconButton('delete', 'Supprimer de Drive', () => run(async () => {
        if (await confirmBox(`Supprimer « ${f.name} » de Google Drive ?`, { ok: 'Supprimer', danger: true })) { await drive.remove(f.id); await showList(); setStatus('Sauvegarde supprimée.'); }
      }, 'Suppression…')))) : [h('p', { class: 'muted small' }, 'Aucune sauvegarde dans Drive pour l’instant.')]);
  };
  const connectBtn = button(drive.isConnected() ? 'Reconnecter' : 'Se connecter à Google', { kind: 'tonal', ic: 'account_circle', onclick: () => run(async () => {
    await drive.connect(s.driveClientId);
    setStatus('Connecté à Google Drive.'); await showList(); rerender();
  }, 'Connexion…') });
  const saveBtn = button('Sauvegarder maintenant', { ic: 'cloud_upload', onclick: () => run(async () => {
    await drive.connect(s.driveClientId, { silent: true });
    const f = await drive.upload(await backupJSON(), { name: `garde-robe-${today()}.json` });
    setStatus(`Sauvegarde envoyée : ${f.name}`); await showList();
  }, 'Envoi vers Drive…') });
  const listBtn = button('Mes sauvegardes', { kind: 'outlined', ic: 'cloud_download', onclick: () => run(async () => { await drive.connect(s.driveClientId, { silent: true }); await showList(); setStatus('Connecté à Google Drive.'); }, 'Chargement…') });
  return h('section', { class: 'card' },
    h('h3', {}, icon('add_to_drive'), ' Google Drive'),
    h('p', { class: 'muted small' }, 'Sauvegardes dans un dossier « Garde-robe numérique » de ton Drive (l’appli ne voit que ses propres fichiers). La clé Gemini n’est jamais incluse.'),
    h('details', { open: s.driveClientId ? null : 'open' }, h('summary', {}, 'Configuration (une seule fois)'),
      h('ol', { class: 'small steps' },
        h('li', {}, 'Sur ', h('a', { href: 'https://console.cloud.google.com/apis/credentials', target: '_blank', rel: 'noopener' }, 'console.cloud.google.com'), ', crée un projet, puis active l’API Google Drive (Bibliothèque).'),
        h('li', {}, 'Écran de consentement OAuth : type Externe, ajoute ton adresse Gmail comme utilisateur test.'),
        h('li', {}, 'Identifiants → Créer → ID client OAuth → Application Web. Origine JavaScript autorisée : ', h('code', {}, location.origin), '.'),
        h('li', {}, 'Colle l’ID client ci-dessous.')),
      h('label', { class: 'field' }, h('span', {}, 'ID client OAuth'), clientIn)),
    h('label', { class: 'switch-row' }, autoCb, h('span', {}, 'Sauvegarde automatique après chaque modification (quand connecté)')),
    h('div', { class: 'row wrap' }, connectBtn, saveBtn, listBtn),
    status, list);
}

async function wipeAll() {
  if (!(await confirmBox('Effacer toutes les pièces, photos, tenues, conversations et le profil de ce téléphone ? C’est définitif.', { ok: 'Tout effacer', danger: true }))) return;
  for (const st of ['items', 'photos', 'weeks', 'kv', 'chat']) await db.clear(st);
  location.reload();
}

init().catch(e => {
  view().replaceChildren(h('section', { class: 'card' }, h('h3', {}, 'Impossible de démarrer'), h('p', {}, String(e?.message || e))));
});
