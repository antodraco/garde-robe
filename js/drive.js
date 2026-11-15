// Sauvegarde sur Google Drive (dossier « Garde-robe numérique »), avec le compte Google de l'utilisateur.
// Autorisation via Google Identity Services ; droit « drive.file » : l'appli ne voit que les fichiers qu'elle a créés.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'Garde-robe numérique';
const AUTO_NAME = 'garde-robe-auto.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class DriveError extends Error {}

let token = null, expiresAt = 0, tokenClient = null, gisLoading = null;

export const isConnected = () => !!token && Date.now() < expiresAt - 60_000;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { gisLoading = null; reject(new DriveError('Impossible de charger la connexion Google. Vérifie ta connexion.')); };
    document.head.append(s);
  });
  return gisLoading;
}

export async function connect(clientId, { silent = false } = {}) {
  if (!clientId) throw new DriveError('Renseigne l’identifiant client Google (OAuth) dans Profil → Google Drive.');
  if (isConnected()) return token;
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r) => {
        if (r?.access_token) {
          token = r.access_token; expiresAt = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          resolve(token);
        } else reject(new DriveError('Connexion Google refusée' + (r?.error ? ` (${r.error})` : '') + '.'));
      },
      error_callback: (e) => reject(new DriveError(e?.type === 'popup_closed' ? 'Fenêtre de connexion fermée.' : 'Connexion Google impossible' + (e?.message ? ` : ${e.message}` : '.'))),
    });
    tokenClient.requestAccessToken({ prompt: silent ? '' : 'consent' });
  });
}

export function disconnect() {
  if (token && window.google?.accounts?.oauth2) { try { window.google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ } }
  token = null; expiresAt = 0;
}

async function api(path, { method = 'GET', query, body, headers = {}, upload = false, raw = false } = {}) {
  if (!isConnected()) throw new DriveError('Non connecté à Google Drive.');
  const url = new URL((upload ? UPLOAD : API) + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, ...headers }, body });
  } catch { throw new DriveError('Google Drive injoignable. Vérifie ta connexion.'); }
  if (res.status === 401) { token = null; throw new DriveError('Session Google expirée : reconnecte-toi.'); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new DriveError(`Erreur Google Drive (${res.status})${j?.error?.message ? ' : ' + j.error.message : ''}`);
  }
  return raw ? res : res.json();
}

let folderId = null;
async function folder() {
  if (folderId) return folderId;
  const q = `name = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await api('/files', { query: { q, fields: 'files(id,name)', spaces: 'drive' } });
  if (found.files?.length) return (folderId = found.files[0].id);
  const created = await api('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) });
  return (folderId = created.id);
}

function multipart(meta, json) {
  const boundary = 'gr' + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
  return { body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

// Sauvegarde datée (nouveau fichier) ou automatique (un seul fichier écrasé).
export async function upload(json, { auto = false, name } = {}) {
  const parent = await folder();
  if (auto) {
    const existing = await api('/files', { query: { q: `name = '${AUTO_NAME}' and '${parent}' in parents and trashed = false`, fields: 'files(id)' } });
    if (existing.files?.length) {
      const { body, headers } = multipart({ name: AUTO_NAME }, json);
      return api(`/files/${existing.files[0].id}`, { method: 'PATCH', upload: true, query: { uploadType: 'multipart', fields: 'id,name,modifiedTime' }, body, headers });
    }
  }
  const { body, headers } = multipart({ name: auto ? AUTO_NAME : name, parents: [parent] }, json);
  return api('/files', { method: 'POST', upload: true, query: { uploadType: 'multipart', fields: 'id,name,modifiedTime' }, body, headers });
}

export async function listBackups() {
  const parent = await folder();
  const r = await api('/files', { query: {
    q: `'${parent}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name,modifiedTime,size)', orderBy: 'modifiedTime desc', pageSize: '20',
  } });
  return r.files || [];
}

export async function download(id) {
  const res = await api(`/files/${id}`, { query: { alt: 'media' }, raw: true });
  return res.text();
}

export async function remove(id) {
  await api(`/files/${id}`, { method: 'DELETE', raw: true });
}
