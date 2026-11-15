// Service worker : l'appli fonctionne hors ligne (sauf IA, météo et Drive, qui demandent Internet)
// et reçoit les images partagées depuis d'autres applis (captures Vinted, photos).
const VERSION = 'garde-robe-v15';
const INBOX = 'inbox';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/ai.js', './js/data.js', './js/db.js', './js/ui.js', './js/weather.js', './js/theme.js', './js/drive.js', './js/vendor/mcu.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![VERSION, 'fonts', INBOX].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Partage vers l'appli (Web Share Target) : les fichiers sont mis de côté, puis l'appli s'ouvre sur le styliste.
async function receiveShare(request) {
  const fd = await request.formData();
  const files = fd.getAll('images').filter(f => f && f.size);
  const text = [fd.get('title'), fd.get('text'), fd.get('url')].filter(Boolean).join('\n');
  const id = Date.now().toString(36);
  const cache = await caches.open(INBOX);
  const names = [];
  for (const [i, f] of files.entries()) {
    const name = `./inbox/${id}-${i}`;
    await cache.put(new Request(name), new Response(f, { headers: { 'Content-Type': f.type || 'image/jpeg' } }));
    names.push(name);
  }
  await cache.put(new Request(`./inbox/${id}`), new Response(JSON.stringify({ text, files: names }), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect(`./?shared=${id}`, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  // Polices Google : cache puis réseau.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open('fonts').then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // Fichiers de l'appli : réseau d'abord (mises à jour), cache si hors ligne.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  }
  // Le reste (Gemini, Open-Meteo, Google Drive) passe directement au réseau.
});
