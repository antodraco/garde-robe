// Appels à Gemini (Google AI Studio) depuis le téléphone, avec la clé de l'utilisateur.
import { CATEGORIES, ETATS, SAISONS, MEASURES, groupOf, GROUP_ORDER, FORMALITE, CHALEUR } from './data.js';
import { weatherLine } from './weather.js';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const MODELS = [
  ['gemini-3.8-flash', 'Gemini 3.8 Flash (recommandé)'],
  ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (plus rapide)'],
];

export class AIError extends Error {}

const S = (extra = {}) => ({ type: 'STRING', ...extra });
const ARR = (items) => ({ type: 'ARRAY', items });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, ...(required ? { required } : {}) });

export async function callGemini({ settings, system, parts, contents, schema, search = false, raw = false }) {
  if (!settings?.apiKey) throw new AIError('Ajoute ta clé API Gemini dans Profil → Réglages.');
  const model = settings.model || DEFAULT_MODEL;
  const body = { contents: contents || [{ role: 'user', parts }], generationConfig: {} };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (search) body.tools = [{ google_search: {} }];
  else if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AIError('Impossible de joindre Gemini. Vérifie ta connexion.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || '';
    if (res.status === 429) throw new AIError('Quota Gemini atteint (offre gratuite). Réessaie dans une minute, ou demain si c’est le quota du jour.');
    if (res.status === 404) throw new AIError(`Modèle « ${model} » introuvable. Choisis-en un autre dans Profil → Réglages.`);
    if (/api key|API_KEY/i.test(msg) || res.status === 401 || res.status === 403) throw new AIError('Clé API Gemini refusée. Vérifie-la dans Profil → Réglages.');
    throw new AIError(`Erreur Gemini (${res.status}) : ${msg}`);
  }
  const cand = data.candidates?.[0];
  if (!cand) throw new AIError('Gemini n’a rien renvoyé' + (data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : '') + '.');
  const text = (cand.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  if (!text) throw new AIError(`Réponse vide de Gemini (${cand.finishReason || 'raison inconnue'}).`);
  const sources = (cand.groundingMetadata?.groundingChunks || [])
    .map(c => c.web).filter(w => w?.uri).map(w => ({ title: w.title || w.uri, uri: w.uri }));
  return raw ? { text, sources } : { json: parseJSON(text), text, sources };
}

export function parseJSON(t) {
  try { return JSON.parse(t); } catch { /* suite */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* suite */ } }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* suite */ } }
  throw new AIError('Réponse de l’IA illisible. Réessaie.');
}

export async function blobToPart(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return { inlineData: { mimeType: blob.type || 'image/jpeg', data: String(dataUrl).split(',')[1] } };
}

/* ---------- Normalisation ---------- */
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function matchFrom(list, value, fallback) {
  const v = norm(value);
  if (!v) return fallback;
  return list.find(x => norm(x) === v) || list.find(x => v.includes(norm(x)) || norm(x).includes(v)) || fallback;
}
const clamp15 = (n, d = 3) => { const x = Math.round(Number(n)); return x >= 1 && x <= 5 ? x : d; };

/* ---------- Nettoyage des champs renvoyés par l'IA ----------
   Certains modèles laissent fuir leur raisonnement dans les valeurs (« … -> coton (sans étiquette)``` Wait … »).
   On coupe au premier signe de raisonnement, on garde la conclusion après la dernière flèche, on rééquilibre
   les parenthèses et on limite la longueur. */
const LEAK = /```|\s(?:Wait|Actually|Let['’]s|Let me|I must|I need|I should|Hmm|NO!)\b|\.\s*(?:Wait|Actually|Let['’]s|Let me|So)\b/;
export function cleanMatiere(v) {
  let s = cleanField(v, 160);
  // « coton (sans étiquette de composition visible, coton très probable…) » → « coton (sans étiquette) »
  if (/sans [ée]tiquette/i.test(s) && !/\d+\s*%/.test(s.split('(')[0])) {
    const base = s.split('(')[0].replace(/[\s,;:.—-]+$/, '').trim();
    s = (base || 'composition inconnue') + ' (sans étiquette)';
  }
  return s;
}
export function cleanField(v, max = 120) {
  let s = String(v ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[`"«»]+$/g, '').replace(/^[`"«»]+/g, '').trim();
  s = s.replace(/\s*\?\s*Non\s*:.*$/i, '');
  const m = s.match(LEAK);
  if (m) s = s.slice(0, m.index);
  if (s.includes('->')) s = s.split('->').pop();
  s = s.trim().replace(/^[\s:;,.—-]+|[\s:;,—-]+$/g, '');
  let open = (s.match(/\(/g) || []).length, close = (s.match(/\)/g) || []).length;
  while (close > open && s.endsWith(')')) { s = s.slice(0, -1).trim(); close--; }
  if (open > close) s += ')'.repeat(open - close);
  if (s.length > max) { const cut = s.lastIndexOf(' ', max - 1); s = s.slice(0, cut > max / 2 ? cut : max - 1).replace(/[\s,;:(—-]+$/, '') + '…'; open = (s.match(/\(/g) || []).length; close = (s.match(/\)/g) || []).length; if (open > close) s = s.replace(/…$/, '…)'); }
  return s;
}

/* ---------- 1. Analyse d'un vêtement en photo ---------- */
const ITEM_SCHEMA = OBJ({
  categorie: S(), nom: S(), couleurPrincipale: S(), couleursSecondaires: ARR(S()), motif: S(),
  matiere: S(), col: S(), manches: S(), coupe: S(), marque: S(), taille: S(),
  saisons: ARR(S()), formalite: { type: 'INTEGER' }, chaleur: { type: 'INTEGER' }, etat: S(), details: S(),
}, ['categorie', 'nom', 'couleurPrincipale', 'couleursSecondaires', 'motif', 'matiere', 'col', 'manches', 'coupe', 'marque', 'taille', 'saisons', 'formalite', 'chaleur', 'etat', 'details']);

export async function analyseItem(settings, photoBlobs) {
  const parts = [];
  for (const b of photoBlobs.slice(0, 6)) parts.push(await blobToPart(b));
  parts.push({ text:
`Analyse ce vêtement (les photos peuvent inclure l'étiquette de composition ou de taille).
Renvoie une fiche en français :
- categorie : exactement une de [${Object.keys(CATEGORIES).join(', ')}]
- nom : nom court et précis, ex. « Polo piqué marine manches courtes »
- couleurPrincipale, couleursSecondaires
- motif : le dessin ET l'armure ou texture du tissu quand elle se voit, ex. « velours côtelé fin uni », « flanelle chinée », « tweed à chevrons », « Prince-de-Galles », « fil-à-fil », « jersey uni ». Regarde de près les gros plans : un velours côtelé, même fin, a des côtes verticales visibles. Reprends cette texture dans le nom (ex. « Pantalon 5 poches velours côtelé marron »).
- matiere : composition exacte recopiée de l'étiquette si elle est lisible (ex. « 90 % laine, 10 % cachemire ») ; sans étiquette lisible, la matière la plus probable suivie de « (sans étiquette) », ex. « coton (sans étiquette) »
- col et manches : seulement pour les hauts, mailles, vestes et manteaux (ex. col boutonné, col V, col roulé ; manches longues) ; chaîne vide pour les bas, chaussures et accessoires
- coupe : la coupe puis les détails de construction utiles au style, en une ligne. Pour un bas : hauteur de taille (basse, normale, haute), pinces (aucune, simple, double), pattes de serrage ou passants de ceinture, patte prolongée, revers (avec hauteur estimée) ou ourlet simple, forme de jambe, longueur pour un short. Ex. « droite, taille normale, passants de ceinture, poches en biais, ourlet simple, au-dessus du genou ». Pour un haut ou une veste : ajusté/regular/ample, boutonnage, poches, fentes.
- marque et taille si lisibles, sinon chaîne vide. taille = l'indication de taille seule et courte, ex. « 44 », « W28 L32 », « 16 ans », « S »
- saisons : parmi [${SAISONS.join(', ')}] (flanelle, tweed, laine épaisse = automne, hiver ; laine fine = toutes ; coton = printemps, été, automne ; lin ou coton très fin = printemps, été)
- formalite : 1 à 5 (${FORMALITE.slice(1).map((l, i) => `${i + 1} = ${l}`).join(', ')})
- chaleur : 1 à 5 (${CHALEUR.slice(1).map((l, i) => `${i + 1} = ${l}`).join(', ')}) ; un short ou une pièce en lin = 1
- etat : un de [${ETATS.join(', ')}]
- details : UNIQUEMENT les défauts et l'usure visibles (tache, trou, bouloches, couture défaite, décoloration…), chaîne vide s'il n'y en a pas. Ne mets PAS ici les éléments de construction : ils vont dans coupe.
Remplis TOUS les champs du JSON (chaîne vide ou liste vide seulement si l'information est vraiment invisible). Lis attentivement chaque étiquette visible : la marque est souvent sur l'étiquette de ceinture, la composition sur l'étiquette de lavage (« Main body », « Shell », « Composition »…).
N'invente rien : laisse vide ce qui n'est pas visible.
Chaque valeur est une donnée courte : jamais de raisonnement, d'hésitation, de commentaire ni de flèche « -> » dans les champs.` });
  const { json } = await callGemini({ settings, parts, schema: ITEM_SCHEMA,
    system: 'Tu es un expert textile et styliste. Tu décris les vêtements avec précision et honnêteté.' });
  return {
    categorie: matchFrom(Object.keys(CATEGORIES), json.categorie, 'Haut (autre)'),
    nom: cleanField(json.nom, 80),
    couleurPrincipale: cleanField(json.couleurPrincipale, 40),
    couleursSecondaires: Array.isArray(json.couleursSecondaires) ? json.couleursSecondaires.map(c => cleanField(c, 30)).filter(Boolean) : [],
    motif: cleanField(json.motif, 60), matiere: cleanMatiere(json.matiere), col: cleanField(json.col, 40), manches: cleanField(json.manches, 40),
    coupe: cleanField(json.coupe, 400), marque: cleanField(json.marque, 40), taille: cleanField(json.taille, 40),
    saisons: (json.saisons || []).map(s => matchFrom(SAISONS, s, null)).filter(Boolean),
    formalite: clamp15(json.formalite), chaleur: clamp15(json.chaleur),
    etat: matchFrom(ETATS, json.etat, 'Très bon état'),
    notes: cleanField(json.details, 400),
  };
}

/* ---------- Textes partagés ---------- */
export function profileText(profile, { withMeasures = false } = {}) {
  const p = profile || {};
  const lines = [];
  const add = (label, v) => { if (v != null && String(v).trim()) lines.push(`- ${label} : ${String(v).trim()}`); };
  add('Style', p.style); add('Couleurs aimées', p.couleursAimees); add('Couleurs/motifs à éviter', p.couleursEvitees);
  add('Coupes préférées', p.coupes); add('Matières', p.matieres); add('À ne jamais proposer', p.interdits);
  add('Contexte et contraintes', p.contraintes);
  add('Règles de style précises', p.regles);
  if (p.formaliteHabituelle) add('Niveau de formalité habituel (1 à 5)', p.formaliteHabituelle);
  if (withMeasures) {
    add('Référentiel de tailles pour les achats', p.referentielAchat);
    const m = [['tailleCm', 'taille'], ['poids', 'poids'], ['cou', 'tour de cou'], ['poitrine', 'tour de poitrine'],
      ['tourTaille', 'tour de taille'], ['hanches', 'tour de hanches'], ['epaules', 'épaules'], ['bras', 'longueur de bras'],
      ['entrejambe', 'entrejambe'], ['pointure', 'pointure']]
      .filter(([k]) => p[k]).map(([k, l]) => `${l} ${p[k]}`).join(', ');
    add('Mensurations (cm sauf mention)', m);
    const t = [['tHaut', 'haut'], ['tChemise', 'chemise'], ['tPantalon', 'pantalon'], ['tVeste', 'veste']]
      .filter(([k]) => p[k]).map(([k, l]) => `${l} ${p[k]}`).join(', ');
    add('Tailles habituelles', t);
  }
  return lines.length ? lines.join('\n') : '- (profil non renseigné)';
}

function itemLine(it, { withSize = false } = {}) {
  const f = [it.id, it.categorie, it.nom, `couleur ${it.couleurPrincipale}${it.couleursSecondaires?.length ? ' + ' + it.couleursSecondaires.join('/') : ''}`];
  if (it.motif) f.push(it.motif);
  if (it.matiere) f.push(it.matiere);
  if (it.col) f.push('col ' + it.col);
  if (it.coupe) f.push('coupe ' + it.coupe);
  f.push(`formalité ${it.formalite || 3}/5`, `chaleur ${it.chaleur || 3}/5`);
  if (it.saisons?.length) f.push('saisons ' + it.saisons.join('/'));
  if (withSize) {
    if (it.marque) f.push('marque ' + it.marque);
    if (it.taille) f.push('taille ' + it.taille);
    const ms = MEASURES[groupOf(it.categorie)].filter(([k]) => it.mesures?.[k]).map(([k, l]) => `${l.toLowerCase()} ${it.mesures[k]} cm`);
    if (ms.length) f.push('mesures : ' + ms.join(', '));
    if (it.etat) f.push('état ' + it.etat);
  }
  const worn = it.porte?.length || 0;
  f.push(worn ? `porté ${worn} fois, dernière ${it.porte[it.porte.length - 1]}` : 'jamais porté via l’appli');
  if (it.notes) f.push('note : ' + it.notes);
  return f.join(' | ');
}

/* ---------- 2. Tenues de la semaine ---------- */
// Une « tenue » couvre plusieurs jours consécutifs (ex. lundi → mercredi), portée tous ces jours-là.
const OUTFITS_SCHEMA = OBJ({
  tenues: ARR(OBJ({ cle: S(), itemIds: ARR(S()), titre: S(), explication: S() }, ['cle', 'itemIds', 'titre', 'explication'])),
  remarque: S(),
}, ['tenues']);

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
export const dayName = (iso) => JOURS[new Date(iso + 'T12:00:00').getDay()];

export async function generateOutfits({ settings, profile, items, slots, weather, history, fixed, weekNote }) {
  const wardrobe = items.filter(i => i.statut === 'garde');
  const available = new Set(wardrobe.map(i => groupOf(i.categorie)));
  const byId = Object.fromEntries(wardrobe.map(i => [i.id, i]));
  const keys = slots.map(s => s.key);
  const weekdays = slots.filter(s => s.key !== 'WE').length + (fixed || []).filter(f => f.key !== 'WE').length;
  const rules = [
    'Chaque tenue contient : 1 ou 2 hauts (ex. t-shirt sous une chemise), exactement 1 bas' +
      (available.has('chaussures') ? ', exactement 1 paire de chaussures' : '') +
      ', 0 ou 1 maille, 0 à 2 pièces de dessus (ex. blazer + manteau), et des accessoires seulement s’ils sont utiles (écharpe/gants/bonnet par temps froid, ceinture avec un pantalon à passants).',
    'Utilise UNIQUEMENT les identifiants de l’inventaire (ex. « v12 »). Ne cite jamais une pièce absente.',
    'IMPORTANT : chaque tenue est portée PLUSIEURS JOURS DE SUITE (tous les jours de sa période). Choisis des pièces robustes et faciles à porter plusieurs jours, et prévois les couches pour le jour le plus froid et le plus pluvieux de la période (une maille ou une pièce de dessus qu’on peut retirer si un jour est plus doux).',
    weekdays >= 2
      ? 'Les tenues de semaine sont emportées ensemble dans un sac le week-end : leurs hauts doivent être différents ; elles peuvent partager le bas et les chaussures pour alléger le sac. Si un manteau ou une veste est nécessaire, utilise LE MÊME pour toutes les tenues de semaine (un seul manteau dans le sac).'
      : 'La tenue de semaine est emportée pour toute la semaine : elle doit couvrir toutes les journées.',
    'La tenue « WE » (week-end, à la maison) est plus décontractée et confortable.',
    'Varie d’une semaine à l’autre : évite les combinaisons et les hauts de l’historique récent et fais tourner les pièces peu portées.',
    'Respecte strictement les goûts et les interdits du profil, et soigne l’harmonie des couleurs et des niveaux de formalité.',
    'titre : nom court et évocateur ; explication : 1 à 2 phrases (pourquoi ces pièces vont ensemble et avec la météo de la période). Dans titre et explication, désigne les pièces par leur nom, jamais par leur identifiant (v12…).',
  ];
  const slotText = slots.map(s =>
    `${s.key} : ${s.label} (${s.dates.length} jour${s.dates.length > 1 ? 's' : ''}${s.key === 'WE' ? ', à la maison' : ''})\n` +
    s.dates.map(d => `   - ${d} (${dayName(d)}) : ${weatherLine(weather?.[d])}`).join('\n')).join('\n');
  const hist = (history || []).slice(-12).map(h => `${h.label} : ${h.itemIds.join(', ')}`).join('\n') || '(aucun)';
  const fixedText = (fixed || []).map(f => `${f.key} (${f.label}) : ${f.itemIds.join(', ')}`).join('\n');
  const text =
`PROFIL ET GOÛTS
${profileText(profile)}

INVENTAIRE DISPONIBLE (id | catégorie | nom | caractéristiques)
${wardrobe.map(i => itemLine(i)).join('\n')}

TENUES À COMPOSER (clé : période, puis météo jour par jour)
${slotText}
${fixedText ? `\nTENUES DÉJÀ CHOISIES CETTE SEMAINE (ne pas répéter leurs hauts)\n${fixedText}\n` : ''}
${weekNote ? `\nREMARQUES POUR CETTE SEMAINE\n${weekNote}\n` : ''}
HISTORIQUE RÉCENT (période : pièces)
${hist}

RÈGLES
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Renvoie exactement une tenue pour chacune de ces clés : ${keys.join(', ')}.`;

  const run = async (extra) => {
    const { json } = await callGemini({ settings, schema: OUTFITS_SCHEMA,
      system: 'Tu es le styliste personnel de l’utilisateur. Tu composes des tenues élégantes, variées et cohérentes avec sa garde-robe réelle. Tu réponds en français.',
      parts: [{ text: text + (extra || '') }] });
    return (json.tenues || []).map(t => ({ ...t, cle: String(t.cle || '').trim().toUpperCase() })).filter(t => keys.includes(t.cle));
  };

  let res = await run();
  let problems = validateOutfits(res, keys, byId, available);
  if (problems.length) {
    res = await run(`\n\nATTENTION, ta proposition précédente avait ces erreurs, corrige-les :\n- ${problems.join('\n- ')}`);
    problems = validateOutfits(res, keys, byId, available);
  }
  const tenues = slots.map(s => {
    const t = res.find(x => x.cle === s.key);
    if (!t) return null;
    const ids = [...new Set(t.itemIds || [])].filter(id => byId[id]);
    ids.sort((a, b) => GROUP_ORDER.indexOf(groupOf(byId[a].categorie)) - GROUP_ORDER.indexOf(groupOf(byId[b].categorie)));
    return { key: s.key, dates: s.dates, itemIds: ids, titre: stripIds(t.titre) || 'Tenue', explication: stripIds(t.explication), porte: false };
  }).filter(Boolean);
  return { tenues, problems };
}

export function validateOutfits(list, keys, byId, available) {
  const problems = [];
  for (const key of keys) {
    const t = list.find(x => x.cle === key);
    if (!t) { problems.push(`${key} : tenue manquante`); continue; }
    const ids = t.itemIds || [];
    const unknown = ids.filter(id => !byId[id]);
    if (unknown.length) problems.push(`${key} : identifiants inexistants ${unknown.join(', ')}`);
    const groups = {};
    ids.filter(id => byId[id]).forEach(id => { const g = groupOf(byId[id].categorie); groups[g] = (groups[g] || 0) + 1; });
    if (available.has('haut') && !(groups.haut >= 1 && groups.haut <= 2)) problems.push(`${key} : il faut 1 ou 2 hauts`);
    if (available.has('bas') && groups.bas !== 1) problems.push(`${key} : il faut exactement 1 bas`);
    if (available.has('chaussures') && groups.chaussures !== 1) problems.push(`${key} : il faut exactement 1 paire de chaussures`);
    if ((groups.maille || 0) > 1) problems.push(`${key} : 1 maille au maximum`);
    if ((groups.dessus || 0) > 2) problems.push(`${key} : 2 pièces de dessus au maximum`);
    const accCats = ids.filter(id => byId[id] && groupOf(byId[id].categorie) === 'accessoire').map(id => byId[id].categorie);
    if (new Set(accCats).size !== accCats.length) problems.push(`${key} : deux accessoires du même type`);
  }
  // Les tenues de semaine ne doivent pas avoir le même haut.
  const weekTops = list.filter(t => t.cle !== 'WE').map(t => (t.itemIds || []).filter(id => byId[id] && groupOf(byId[id].categorie) === 'haut'));
  if (weekTops.length >= 2 && weekTops[0].some(id => weekTops[1].includes(id))) problems.push('les deux tenues de semaine partagent un haut');
  // Un seul manteau dans le sac : si les deux tenues de semaine ont une pièce de dessus, ce doit être la même.
  const coats = list.filter(t => t.cle !== 'WE').map(t => (t.itemIds || []).filter(id => byId[id] && groupOf(byId[id].categorie) === 'dessus'));
  if (coats.length >= 2 && coats[0].length && coats[1].length && !coats[0].some(id => coats[1].includes(id))) {
    problems.push('les deux tenues de semaine ont des manteaux/vestes différents : utilise le même pour n’emporter qu’un seul manteau');
  }
  return problems;
}

/* ---------- 2b. Contexte complet pour le styliste (chat) ---------- */
export function wardrobeContext({ profile, items, weeks = [], today }) {
  const kept = items.filter(i => i.statut === 'garde');
  const selling = items.filter(i => ['a_vendre', 'en_vente'].includes(i.statut));
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const name = (id) => byId[id]?.nom || id;
  const recent = weeks.filter(w => w.weekStart <= today).sort((a, b) => b.weekStart.localeCompare(a.weekStart)).slice(0, 4)
    .flatMap(w => (w.tenues || []).map(t => `${t.dates[0]} → ${t.dates[t.dates.length - 1]}${t.porte ? ' (portée)' : ''} : ${t.itemIds.map(name).join(', ')}`));
  const next = weeks.filter(w => w.weekStart > today).sort((a, b) => a.weekStart.localeCompare(b.weekStart))[0];
  const planned = next ? (next.tenues || []).map(t => `${t.dates[0]} → ${t.dates[t.dates.length - 1]} : ${t.itemIds.map(name).join(', ')}`) : [];
  return `PROFIL, GOÛTS, MENSURATIONS
${profileText(profile, { withMeasures: true })}

GARDE-ROBE ACTUELLE (${kept.length} pièces ; id | catégorie | nom | caractéristiques)
${kept.map(i => itemLine(i, { withSize: true })).join('\n') || '(vide)'}
${selling.length ? `\nPIÈCES EN COURS DE VENTE (plus disponibles pour les tenues)\n${selling.map(i => `${i.id} | ${i.categorie} | ${i.nom}`).join('\n')}\n` : ''}
TENUES RÉCENTES
${recent.join('\n') || '(aucune)'}

TENUES PRÉVUES
${planned.join('\n') || '(aucune)'}

Date du jour : ${today}.`;
}

export const STYLIST_SYSTEM = `Tu es le styliste personnel de l’utilisateur, à sa disposition dans son application de garde-robe. Tu connais par cœur son profil, ses règles de style, ses mensurations et CHAQUE pièce de sa garde-robe (listées ci-dessous avec leurs identifiants). Tu réponds en français, de façon précise et concise, avec un ton de conseiller de confiance : direct, chaleureux, jamais flatteur.

Principes :
1. Rigueur : le style choisi par l’utilisateur (voir profil) se respecte strictement. Signale sans détour tout ce qui s’en écarte : coupe, proportions, longueur de manche ou d’ourlet, couleur, matière, formalité, accessoire.
2. Mémoire de la garde-robe : avant de conseiller, regarde ce qu’il possède. Propose d’abord des associations avec ses pièces (cite leur nom), un achat seulement si rien dans la garde-robe ne convient.
3. Bienveillance éclairée : quand une pièce a été portée faute de mieux (il le dit, ou sa garde-robe n’offre pas d’alternative), ne le lui reproche pas. Note le compromis et dis ce qui le réglerait (autre association disponible, ou pièce à acheter).
4. Achats et trouvailles (captures d’écran Vinted ou autres) : juge la pièce sur trois axes — cohérence avec le style, matière et saison, taille par rapport à son référentiel (compare les mesures à plat de l’annonce à ses mesures ; si l’annonce ne les donne pas, dis exactement quelles mesures demander au vendeur). Termine par un verdict clair : « À prendre », « À vérifier (quoi) » ou « À passer », avec le prix qui te semble juste si l’annonce en montre un.
5. Photos de lui en tenue : examine chaque détail visible (tombé, longueurs, superpositions, couleurs, chaussures, accessoires), dis ce qui est réussi et ce qui ne l’est pas, puis donne la correction concrète, avec ses pièces.
6. Quand tu proposes une tenue, utilise les noms exacts des pièces de l’inventaire. N’invente jamais une pièce qu’il n’a pas.
7. Mise en forme légère : phrases courtes, listes seulement quand elles aident, pas de titres pompeux, pas d’emoji.
8. Désigne toujours les pièces par leur nom (ex. « ton pantalon en flanelle grise »), jamais par leur identifiant technique (v12, v34…).`;

// Les identifiants internes (v12, v34…) servent à l'IA pour désigner les pièces ; on ne les montre jamais.
export function stripIds(t) {
  return String(t ?? '')
    .replace(/\s*\((?:\s*v\d+\s*[,/;et]*\s*)+\)/g, '')       // « (v34) », « (v34, v57) »
    .replace(/\s*\[(?:\s*v\d+\s*[,/;]*\s*)+\]/g, '')         // « [v34] »
    .replace(/\b(id|réf\.?)\s+v\d+\b\s*/gi, '')
    .replace(/(\S)\s+v\d+\b(?=[\s,.;:!?)]|$)/g, '$1')              // « chambray gris v31 et » → « chambray gris et »
    .replace(/(^|[\s«"'])v\d+\s*[:–—-]\s*/g, '$1')               // « v34 : Pantalon… »
    .replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?)])/g, '$1');
}

export async function chatReply({ settings, context, history, message, images = [] }) {
  const contents = [];
  for (const m of history) {
    const parts = [];
    for (const img of (m.sendImages || [])) parts.push(await blobToPart(img));
    if (m.imageNote) parts.push({ text: m.imageNote });
    if (m.text) parts.push({ text: m.text });
    if (parts.length) contents.push({ role: m.role, parts });
  }
  const parts = [];
  for (const img of images) parts.push(await blobToPart(img));
  parts.push({ text: message || (images.length ? 'Donne-moi ton avis.' : '') });
  contents.push({ role: 'user', parts });
  const { text } = await callGemini({ settings, raw: true, contents, system: STYLIST_SYSTEM + '\n\n' + context });
  return stripIds(text);
}

/* ---------- 2c. Recommandations d'achats ---------- */
const WISHLIST_SCHEMA = OBJ({
  articles: ARR(OBJ({
    nom: S(), categorie: S(), pourquoi: S(), priorite: { type: 'INTEGER' }, budget: S(), taille: S(), motsClesVinted: S(), criteres: S(),
  }, ['nom', 'categorie', 'pourquoi', 'priorite'])),
  bilan: S(),
}, ['articles', 'bilan']);

export async function recommendPurchases({ settings, context, wishlist = [], note }) {
  const owned = wishlist.filter(w => w.statut !== 'ignore').map(w => `- ${w.nom} (${w.statut === 'achete' ? 'déjà acheté' : 'déjà sur la liste'})`).join('\n');
  const text = `${context}

LISTE D’ACHATS ACTUELLE
${owned || '(vide)'}
${note ? `\nDEMANDE PARTICULIÈRE\n${note}\n` : ''}
Propose les pièces à acheter qui rendraient cette garde-robe nettement plus complète et polyvalente, en respectant strictement le style, les matières, les couleurs et le référentiel de tailles du profil. Tiens compte de la saison actuelle et du mode de vie (1 ou 2 tenues emportées pour la semaine). Pas plus de 8 articles, du plus utile au moins utile ; ne répète pas ce qui est déjà sur la liste ou déjà acheté.
Pour chaque article : nom précis, categorie (une de [${Object.keys(CATEGORIES).join(', ')}]), pourquoi (1 phrase : quel manque il comble, avec quelles pièces existantes il s’associe), priorite (1 = indispensable, 2 = utile, 3 = plaisir), budget (fourchette en euros, occasion), taille (taille à chercher d’après le référentiel), motsClesVinted (mots-clés à taper dans la recherche Vinted, séparés par des virgules), criteres (ce qu’il faut vérifier sur l’annonce : matière, mesures à plat, état…).
Termine par un bilan (2 phrases).`;
  const { json } = await callGemini({ settings, schema: WISHLIST_SCHEMA, parts: [{ text }],
    system: 'Tu es un conseiller en garde-robe masculine exigeant et pragmatique. Tu réponds en français.' });
  const cats = Object.keys(CATEGORIES);
  return {
    articles: (json.articles || []).map(a => ({
      nom: String(a.nom || '').slice(0, 80), categorie: matchFrom(cats, a.categorie, 'Accessoire (autre)'), pourquoi: a.pourquoi || '',
      priorite: [1, 2, 3].includes(Number(a.priorite)) ? Number(a.priorite) : 2, budget: a.budget || '', taille: a.taille || '',
      motsClesVinted: a.motsClesVinted || '', criteres: a.criteres || '',
    })).filter(a => a.nom),
    bilan: stripIds(json.bilan),
  };
}

/* ---------- 3. Tri de la garde-robe ---------- */
const TRI_SCHEMA = OBJ({
  articles: ARR(OBJ({ id: S(), decision: S(), raison: S() }, ['id', 'decision', 'raison'])),
  bilan: S(), manques: ARR(S()),
}, ['articles', 'bilan']);

export async function triWardrobe({ settings, profile, items }) {
  const wardrobe = items.filter(i => i.statut === 'garde');
  const text =
`PROFIL (goûts et mensurations)
${profileText(profile, { withMeasures: true })}

GARDE-ROBE ACTUELLE
${wardrobe.map(i => itemLine(i, { withSize: true })).join('\n')}

Pour CHAQUE pièce, décide :
- « garder » : elle lui va probablement, s'associe à d'autres pièces et sert à une saison ou une occasion de sa vie réelle ;
- « vendre » : seulement si c'est CERTAIN — taille clairement incompatible (mesures à plat qui sortent nettement de son référentiel, ou taille enfant / XL / W32+ évidente), pièce abîmée, ou vrai doublon sans aucune utilité ;
- « verifier » : dès qu'il y a un doute (dis précisément quoi vérifier : essayage, mesure à plat, étiquette).

RÈGLES DE PRUDENCE (obligatoires) :
1. Taille : une étiquette ne prouve rien seule. « M » n'est PAS automatiquement trop grand : les tailles varient selon les marques ; le profil ne mentionne que quelques marques précises où le M est trop grand. Sans mesure à plat qui le prouve, une taille M, L, 38, 40 ou absente → « verifier », jamais « vendre ».
2. Saisons : juge chaque pièce pour SA saison. Les règles d'hiver du profil (laine, flanelle, taille haute, pas de synthétique…) concernent les pantalons et pulls d'HIVER. Un short, un chino ou un pull en coton pour le printemps ou l'été est normal et utile : ne le reproche pas parce qu'il n'est pas en laine.
3. Usage réel : il est étudiant, marche beaucoup, rentre chez ses parents le week-end. Il lui faut aussi des pièces décontractées (week-end, été, maison, travaux) : un jean, des shorts, des chinos de couleur, des pulls en coton ont leur place.
4. Garde un vestiaire complet : pour chaque catégorie et chaque saison, garde assez de pièces pour tourner (au moins 4 à 6 hauts de mi-saison, 3 à 4 bas de mi-saison, 2 à 3 shorts, les pulls d'hiver). Ne vide jamais une catégorie, même si les pièces ne sont pas idéales : mieux vaut une pièce correcte en attendant un remplacement.
5. Doublon : deux pièces proches ne sont pas un doublon inutile s'il faut de quoi tourner dans la semaine.
6. Couleurs : les « couleurs évitées » du profil sont des préférences pour les tenues habillées ; une couleur vive en été (short rose saumon, chino bleu ciel) peut rester si elle va avec ses hauts.
7. Ne recommande jamais de vendre la pièce de référence (Suitsupply Duca) ni les pièces citées comme « dépannage ».
Vise une proposition raisonnable : en général, pas plus d'un quart des pièces à vendre ; le reste en « garder » ou « verifier ».
Pour « vendre », précise dans la raison si la pièce vaut la peine d'une annonce (marque, bon état : au moins 10 € attendus) ou s'il vaut mieux la donner. Sois concret (1 phrase).
Ajoute un bilan (2 à 3 phrases, bienveillant et réaliste) et la liste des « manques » : pièces qui rendraient la garde-robe bien plus polyvalente.`;
  const { json } = await callGemini({ settings, schema: TRI_SCHEMA, parts: [{ text }],
    system: 'Tu es un conseiller en garde-robe pragmatique, honnête et prudent : tu ne fais jamais jeter ou vendre une pièce sur une simple supposition. Tu réponds en français.' });
  const ids = new Set(wardrobe.map(i => i.id));
  const articles = (json.articles || []).filter(a => ids.has(a.id)).map(a => ({
    id: a.id, raison: stripIds(a.raison),
    decision: /vend/i.test(a.decision) ? 'vendre' : /v[eé]rif/i.test(a.decision) ? 'verifier' : 'garder',
  }));
  return { articles, bilan: stripIds(json.bilan), manques: (json.manques || []).map(stripIds), date: new Date().toISOString() };
}

/* ---------- 4. Annonce Vinted ---------- */
const LISTING_SCHEMA = OBJ({
  titre: S(), description: S(), categorieVinted: S(), marque: S(), taille: S(), etat: S(),
  couleurs: ARR(S()), matiere: S(), prix: { type: 'NUMBER' }, prixMin: { type: 'NUMBER' }, prixMax: { type: 'NUMBER' },
  justificationPrix: S(), photosAFaire: ARR(S()), mesuresManquantes: ARR(S()), conseils: S(),
}, ['titre', 'description', 'etat', 'prix']);

export async function makeListing({ settings, item, photoBlobs, search }) {
  const parts = [];
  for (const b of (photoBlobs || []).slice(0, 3)) parts.push(await blobToPart(b));
  const group = groupOf(item.categorie);
  const measures = MEASURES[group].map(([k, l]) => `${l} : ${item.mesures?.[k] ? item.mesures[k] + ' cm' : 'NON MESURÉ'}`).join('\n');
  const text =
`Rédige une annonce Vinted (France) pour cet article d'homme.

FICHE
${itemLine(item, { withSize: true })}
Mesures à plat :
${measures}

CONSIGNES
- titre : 50 caractères maximum, espaces compris. Ordre conseillé : type + marque + détail clé + couleur + taille. Pas d'emoji, pas de majuscules criardes.
- description : en français, 400 à 900 caractères, ton simple et honnête. Structure : une phrase d'accroche ; détails (coupe, col, matière/composition) ; mesures à plat en cm (uniquement celles fournies, n'en invente aucune) ; état réel avec les éventuels défauts ; envoi soigné. Termine par 4 à 6 mots-clés pertinents précédés de #.
- categorieVinted : chemin probable dans Vinted, ex. « Hommes > Vêtements > Hauts et t-shirts > Polos ».
- etat : exactement un de [${ETATS.join(', ')}].
- couleurs : 1 ou 2 couleurs principales.
- prix : prix juste en euros pour vendre en quelques semaines sur Vinted, d'après la marque, l'état, la matière et les prix habituels de l'occasion ; donne prixMin et prixMax et une justificationPrix courte.${search ? ' Utilise la recherche Google pour trouver des prix comparables (Vinted, Leboncoin, prix neuf) et cite ce que tu as trouvé dans la justification.' : ''}
- photosAFaire : liste courte des photos à prendre (vue de face à plat, dos, étiquette, détails, défauts…).
- mesuresManquantes : mesures utiles qui ne sont pas fournies.
- conseils : 1 ou 2 astuces pour mieux vendre cet article.
${search ? 'Réponds UNIQUEMENT avec un objet JSON contenant ces clés : titre, description, categorieVinted, marque, taille, etat, couleurs, matiere, prix, prixMin, prixMax, justificationPrix, photosAFaire, mesuresManquantes, conseils.' : ''}`;
  parts.push({ text });
  const system = 'Tu es un vendeur Vinted expérimenté et honnête. Tu rédiges des annonces claires qui vendent vite à un prix juste.';
  let out;
  try {
    out = await callGemini({ settings, parts, schema: LISTING_SCHEMA, search, system });
  } catch (e) {
    if (!search || !(e instanceof AIError) || /quota|clé|connexion/i.test(e.message)) throw e;
    out = await callGemini({ settings, parts, schema: LISTING_SCHEMA, search: false, system });
    out.searchFailed = true;
  }
  const j = out.json;
  const num = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : null);
  let titre = String(j.titre || '').trim();
  const titreTronque = titre.length > 50;
  if (titreTronque) titre = titre.slice(0, 50).replace(/\s+\S*$/, '').trim() || titre.slice(0, 50);
  return {
    titre, titreTronque,
    description: String(j.description || '').trim(),
    categorieVinted: j.categorieVinted || '', marque: j.marque || item.marque || '', taille: j.taille || item.taille || '',
    etat: matchFrom(ETATS, j.etat, item.etat || 'Très bon état'),
    couleurs: (j.couleurs || []).slice(0, 2), matiere: j.matiere || item.matiere || '',
    prix: num(j.prix), prixMin: num(j.prixMin), prixMax: num(j.prixMax),
    justificationPrix: j.justificationPrix || '', photosAFaire: j.photosAFaire || [],
    mesuresManquantes: j.mesuresManquantes || [], conseils: j.conseils || '',
    sources: out.sources || [], rechercheEnLigne: !!search && !out.searchFailed,
    date: new Date().toISOString(),
  };
}
