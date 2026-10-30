// Google Drive client. OAuth via Google Identity Services (token flow), scope drive.file only:
// Lipat can see and edit only the files it created, plus files the user picks in the Google Picker.
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const TOKEN_KEY = 'lipat.drive.token';

let gisLoading = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = GIS_SRC; s.async = true; s.defer = true;
    s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign-in'));
    document.head.appendChild(s);
  });
  return gisLoading;
}

// Google Picker, for adding books from Drive. Picking a file grants drive.file access to that file only.
const GAPI_SRC = 'https://apis.google.com/js/api.js';
let pickerLoading = null;
function loadPicker() {
  if (window.google?.picker) return Promise.resolve();
  if (pickerLoading) return pickerLoading;
  pickerLoading = new Promise((res, rej) => {
    const fail = () => { pickerLoading = null; rej(new Error('Could not load the Google Drive picker')); };
    const s = document.createElement('script'); s.src = GAPI_SRC; s.async = true;
    s.onload = () => window.gapi.load('picker', { callback: res, onerror: fail }); s.onerror = fail;
    document.head.appendChild(s);
  });
  return pickerLoading;
}

export class DriveError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

export class Drive {
  constructor(clientId) {
    this.clientId = clientId;
    this.client = null;
    try { const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); if (t && t.exp > Date.now() + 60e3) this._token = t; } catch {}
  }
  get hasToken() { return !!(this._token && this._token.exp > Date.now() + 60e3); }

  // interactive: may show Google's popup (must be called from a user gesture on mobile)
  async token({ interactive = false } = {}) {
    if (this.hasToken) return this._token.value;
    await loadGis();
    return new Promise((resolve, reject) => {
      this.client = window.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId, scope: SCOPE,
        callback: (r) => {
          if (r && r.access_token) {
            this._token = { value: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
            try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(this._token)); } catch {}
            resolve(r.access_token);
          } else reject(new DriveError(r?.error_description || r?.error || 'No token', r?.error || 'no_token'));
        },
        error_callback: (e) => reject(new DriveError(e?.message || e?.type || 'Sign-in cancelled', e?.type || 'popup')),
      });
      this.client.requestAccessToken({ prompt: interactive ? (this._everConsented ? '' : 'consent') : '' });
      this._everConsented = true;
    });
  }
  forget() {
    const t = this._token; this._token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
    if (t && window.google?.accounts?.oauth2) try { window.google.accounts.oauth2.revoke(t.value, () => {}); } catch {}
  }

  async api(path, { method = 'GET', params = null, body = null, headers = {}, upload = false, raw = false } = {}) {
    const tok = await this.token();
    const url = new URL((upload ? UPLOAD : API) + path);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + tok, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && !raw ? JSON.stringify(body) : body });
    if (res.status === 401) { this._token = null; try { sessionStorage.removeItem(TOKEN_KEY); } catch {} throw new DriveError('Signed out of Google', 'auth'); }
    if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error?.message || msg; } catch {} throw new DriveError(msg, 'http' + res.status); }
    return res.status === 204 ? null : res.json();
  }

  // Load sign-in and picker scripts ahead of the tap, so the sign-in popup still counts as user-initiated on mobile.
  prepare() { return Promise.all([loadGis(), loadPicker()]).catch(() => {}); }

  // Show the Google Picker. Resolves to [{ id, name, mimeType }], or [] if cancelled.
  // apiKey is a browser key with the Picker API enabled; the app ID is the Cloud project number, which the client ID starts with.
  async pick({ apiKey, mimeTypes }) {
    const tok = await this.token({ interactive: true });
    await loadPicker();
    const P = window.google.picker;
    return new Promise((resolve) => {
      const view = new P.DocsView(P.ViewId.DOCS).setMimeTypes(mimeTypes.join(',')).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(P.DocsViewMode.LIST);
      new P.PickerBuilder()
        .addView(view)
        .enableFeature(P.Feature.MULTISELECT_ENABLED)
        .setOAuthToken(tok).setDeveloperKey(apiKey).setAppId(this.clientId.split('-')[0])
        .setTitle('Add books from Google Drive')
        .setCallback((d) => {
          const action = d[P.Response.ACTION];
          if (action === P.Action.PICKED) resolve(d[P.Response.DOCUMENTS].map(x => ({ id: x[P.Document.ID], name: x[P.Document.NAME], mimeType: x[P.Document.MIME_TYPE] || '' })));
          else if (action === P.Action.CANCEL) resolve([]);
        })
        .build().setVisible(true);
    });
  }

  // File bytes as a Blob.
  async download(id) {
    const tok = await this.token();
    const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: 'Bearer ' + tok } });
    if (res.status === 401) { this._token = null; try { sessionStorage.removeItem(TOKEN_KEY); } catch {} throw new DriveError('Signed out of Google', 'auth'); }
    if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error?.message || msg; } catch {} throw new DriveError(msg, 'http' + res.status); }
    return res.blob();
  }

  async findFolder(name, parentId = 'root') {
    const q = `name = '${esc(name)}' and mimeType = '${FOLDER}' and '${parentId}' in parents and trashed = false`;
    const r = await this.api('/files', { params: { q, fields: 'files(id,name)', pageSize: 5 } });
    return r.files[0] || null;
  }
  async ensureFolder(name, parentId = 'root') {
    const f = await this.findFolder(name, parentId);
    if (f) return f.id;
    const r = await this.api('/files', { method: 'POST', body: { name, mimeType: FOLDER, parents: [parentId] }, params: { fields: 'id' } });
    return r.id;
  }
  async findByProp(key, value, parentId) {
    const q = `appProperties has { key='${esc(key)}' and value='${esc(value)}' } and trashed = false` + (parentId ? ` and '${parentId}' in parents` : '');
    const r = await this.api('/files', { params: { q, fields: 'files(id,name)', pageSize: 5 } });
    return r.files[0] || null;
  }
  async getFile(id) { try { return await this.api(`/files/${id}`, { params: { fields: 'id,name,trashed' } }); } catch (e) { if (String(e.code) === 'http404') return null; throw e; } }

  // Create or update a Markdown file. Returns the file id.
  async upsertMarkdown({ name, parentId, content, props = {}, fileId = null }) {
    let id = fileId;
    if (id) { const f = await this.getFile(id); if (!f || f.trashed) id = null; }
    if (!id && props.key) { const f = await this.findByProp(props.key, props.value, parentId); if (f) id = f.id; }
    const meta = { name, mimeType: 'text/markdown', ...(props.key ? { appProperties: { [props.key]: props.value } } : {}) };
    if (!id) meta.parents = [parentId];
    const boundary = 'dogear' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    const r = await this.api(id ? `/files/${id}` : '/files', {
      method: id ? 'PATCH' : 'POST', upload: true, raw: true, body,
      params: { uploadType: 'multipart', fields: 'id,name' },
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
    return r.id;
  }
}
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
