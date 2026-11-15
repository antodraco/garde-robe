// Thème dynamique Material You : même algorithme qu'Android (quantification Celebi + score + schéma Tonal Spot).
import { argbFromHex, hexFromArgb, argbFromRgb, Hct, SchemeTonalSpot, MaterialDynamicColors, QuantizerCelebi, Score } from './vendor/mcu.js';

export const DEFAULT_SEED = '#4A5FA8';
export const PRESETS = ['#4A5FA8', '#6750A4', '#3F6837', '#006A6A', '#8C4A60', '#9A4521', '#7B5800', '#5E5F5A'];

const ROLES = ['primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'secondary', 'onSecondary', 'secondaryContainer',
  'onSecondaryContainer', 'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer', 'error', 'onError', 'errorContainer',
  'onErrorContainer', 'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant', 'surfaceContainerLowest', 'surfaceContainerLow',
  'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest', 'outline', 'outlineVariant', 'inverseSurface',
  'inverseOnSurface', 'inversePrimary'];
const kebab = (s) => s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());

function tokens(seed, dark) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seed)), dark, 0);
  const out = {};
  for (const r of ROLES) out[r] = hexFromArgb(MaterialDynamicColors[r].getArgb(scheme));
  return out;
}

const block = (t) => ROLES.map(r => `--md-${kebab(r)}:${t[r]};`).join('');

export function applyTheme(seed, mode) {
  let valid = /^#[0-9a-f]{6}$/i.test(seed || '') ? seed : DEFAULT_SEED;
  const light = tokens(valid, false);
  const dark = tokens(valid, true);
  const css = `:root{${block(light)}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${block(dark)}}}` +
    `:root[data-theme="dark"]{${block(dark)}}`;
  let style = document.getElementById('dynamic-theme');
  if (!style) { style = document.createElement('style'); style.id = 'dynamic-theme'; document.head.append(style); }
  style.textContent = css;

  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;

  // Barre d'état Android : même couleur que le fond de l'appli.
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const add = (color, media) => {
    const m = document.createElement('meta');
    m.name = 'theme-color'; m.content = color;
    if (media) m.media = media;
    document.head.append(m);
  };
  if (mode === 'light') add(light.surface);
  else if (mode === 'dark') add(dark.surface);
  else { add(light.surface, '(prefers-color-scheme: light)'); add(dark.surface, '(prefers-color-scheme: dark)'); }
}

// Extrait jusqu'à 4 couleurs sources d'une image (capture du fond d'écran), comme le fait Android.
export async function seedsFromImage(file) {
  const bmp = await createImageBitmap(file);
  const size = 128;
  const s = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 255) continue;
    pixels.push(argbFromRgb(data[i], data[i + 1], data[i + 2]));
  }
  const quantized = QuantizerCelebi.quantize(pixels, 128);
  return Score.score(quantized, { desired: 4 }).map(hexFromArgb);
}
