import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import fetch from 'node-fetch';
import { WebSocket as WS } from 'ws'; // <-- static import (fix)
import fs from 'fs';
import path from 'path';
import url from 'url';
import { createStore } from './storage.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Render is behind a proxy
const app = express();
app.set('trust proxy', 1);

/* ========== .env loader (local dev) ========== */
const dotenvPath = path.join(__dirname, '.env');
if (fs.existsSync(dotenvPath)) {
  const lines = fs.readFileSync(dotenvPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) process.env[m[1]] = m[2];
  }
}

/* ========== Config ========== */
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BROADCASTER_LOGIN = (process.env.BROADCASTER_LOGIN || '').toLowerCase();
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL = process.env.DATABASE_URL || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/,'');

/* ========== Normalize + Reward mapping ========== */
const norm = (s) => (s || '').toString()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();
const stripEmoji = (s) => s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();

const DEFAULT_REWARD_MAP = {
  "heal💓": 1, "heal": 1,
  "eat🍏": 1, "eat": 1,
  "hydrate💧": 1, "hydrate": 1,
  "bleed🩸": -1, "bleed": -1,
  "thirst🥵": -1, "thirst": -1,
  "hunger🦴": -1, "hunger": -1
};
function buildNormalizedMap(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const nk = norm(k);
    out[nk] = v;
    out[stripEmoji(nk)] = v;
  }
  return out;
}
let RAW_REWARD_MAP = DEFAULT_REWARD_MAP;
try {
  if (process.env.REWARD_MAP_JSON) RAW_REWARD_MAP = JSON.parse(process.env.REWARD_MAP_JSON);
} catch (e) { console.warn('[WARN] Invalid REWARD_MAP_JSON:', e.message); }
const REWARD_MAP = buildNormalizedMap(RAW_REWARD_MAP);

/* ========== Stores ========== */
const store = await createStore({ __dirname, DATABASE_URL });
await store.init();

/* ========== HTTP helper ========== */
async function fetchJSON(urlStr, options = {}) {
  const res = await fetch(urlStr, options);
  if (!res.ok) {
    const text = await res.text().catch(()=>'[no text]');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

/* ========== OAuth ========== */
const SCOPES = ['channel:read:redemptions'];
function redirectUri() {
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  return `${base}/auth/callback`;
}
function authURL() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' ')
    // force_verify removed to avoid certain loops
  });
  return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
}
async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri()
  });
  return await fetchJSON('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
}
async function refreshToken(refresh_token) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token,
    grant_type: 'refresh_token'
  });
  return await fetchJSON('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
}
async function getUserInfo(access_token) {
  const res = await fetch('https://api.twitch.tv/helix/users', {
    headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${access_token}` }
  });
  if (!res.ok) throw new Error(`getUserInfo failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.data && j.data[0];
}

/* ========== EventSub WebSocket ========== */
class EventSubWS {
  constructor({ accessToken, broadcasterId }) {
    this.accessToken = accessToken;
    this.broadcasterId = broadcasterId;
    this.ws = null;
    this.sessionId = null;
    this.reconnectUrl = null;
    this.url = 'wss://eventsub.wss.twitch.tv/ws';
  }
  start() { this.connect(this.url); }
  stop() { if (this.ws) this.ws.close(); this.ws = null; this.sessionId = null; this.reconnectUrl = null; }

  connect(url) {
    console.log('[EventSub] Connecting:', url);
    this.ws = new WS(url); // <-- fixed
    this.ws.on('open', () => console.log('[EventSub] WS open'));
    this.ws.on('close', (code, reason) => {
      console.log('[EventSub] WS closed', code, reason?.toString() || '');
      setTimeout(() => this.connect(this.reconnectUrl || this.url), 2000);
    });
    this.ws.on('error', (err) => console.error('[EventSub] WS error', err.message));
    this.ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const t = data?.metadata?.message_type;

        if (t === 'session_welcome') {
          this.sessionId = data?.payload?.session?.id;
          console.log('[EventSub] Welcome. session_id=', this.sessionId);
          await this.ensureSubscriptions();
        } else if (t === 'session_reconnect') {
          this.reconnectUrl = data?.payload?.session?.reconnect_url;
          console.log('[EventSub] Reconnect requested →', this.reconnectUrl);
          this.stop();
          this.connect(this.reconnectUrl);
        } else if (t === 'notification') {
          const subType = data?.metadata?.subscription_type;
          const event = data?.payload?.event;

          if (subType === 'channel.channel_points_custom_reward_redemption.add') {
            const redId = event?.id;
            const user = event?.user_name || event?.user_login || 'unknown';
            const title = event?.reward?.title || '';
            const rewardId = event?.reward?.id;
            const key = norm(title);
            const delta = REWARD_MAP[key] ?? REWARD_MAP[stripEmoji(key)] ?? 0;
            if (!delta) { console.log(`[PENDING] Ignored unmapped reward "${title}" from ${user}`); return; }
            await store.pendingAdd({
              id: redId, user, title, delta,
              reward_id: rewardId, broadcaster_id: this.broadcasterId, at: Date.now(),
              status: 'UNFULFILLED'
            });
            console.log(`[PENDING] Added "${title}" by ${user} (delta ${delta}) id=${redId}`);
            io.emit('karma:pending', { id: redId, user, title, delta });
          }

          if (subType === 'channel.channel_points_custom_reward_redemption.update') {
            const redId = event?.id;
            const status = (event?.status || '').toUpperCase(); // FULFILLED | CANCELED
            const rec = await store.pendingGet(redId);
            console.log(`[UPDATE] Redemption id=${redId} status=${status}`);
            if (!rec) return;
            if (status === 'FULFILLED') {
              const value = await store.applyDelta(rec.user, rec.delta);
              broadcastUpdate(rec.user, value, rec.delta, `reward:${rec.title}`);
              await store.pendingDelete(redId);
            } else if (status === 'CANCELED') {
              await store.pendingDelete(redId);
              console.log(`[PENDING] Canceled "${rec.title}" by ${rec.user} → removed`);
            }
          }
        }
      } catch (e) { console.error('[EventSub] parse error', e); }
    });
  }

  async ensureSubscriptions() {
    if (!this.sessionId) return;
    try {
      const list = await this.apiListSubs();
      const toDelete = (list.data || []).filter(s =>
        ['channel.channel_points_custom_reward_redemption.add',
         'channel.channel_points_custom_reward_redemption.update'
        ].includes(s.type) && s.transport?.method === 'websocket'
      );
      for (const s of toDelete) await this.apiDeleteSub(s.id);
    } catch (e) { console.warn('[EventSub] list/delete subs:', e.message); }

    await this.apiCreateSub('channel.channel_points_custom_reward_redemption.add', '1', {
      broadcaster_user_id: this.broadcasterId
    });
    await this.apiCreateSub('channel.channel_points_custom_reward_redemption.update', '1', {
      broadcaster_user_id: this.broadcasterId
    });
    console.log('[EventSub] Subscribed to redemption ADD + UPDATE');
  }

  async apiCreateSub(type, version, condition) {
    const body = { type, version, condition, transport: { method: 'websocket', session_id: this.sessionId } };
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-ID': CLIENT_ID,
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`CreateSub ${type} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async apiListSubs() {
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${this.accessToken}` }
    });
    if (!res.ok) throw new Error(`ListSub failed ${res.status}`);
    return res.json();
  }
  async apiDeleteSub(id) {
    const res = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${this.accessToken}` }
    });
    if (!res.ok) throw new Error(`DeleteSub failed ${res.status}`);
  }
}

/* ========== CORS + JSON ========== */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

/* ========== Socket.IO + Server ========== */
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

function broadcastUpdate(user, value, delta, source) {
  io.emit('karma:update', { user, value, delta, source, at: Date.now() });
  console.log(`[KARMA] ${user} ${delta >= 0 ? '+' : ''}${delta} -> ${value} (${source})`);
}

/* ========== Routes ========== */
app.get('/', (req, res) => res.type('text/plain').send('Doomz Karma Service (oauth-debug-fixed) running.'));

app.get('/auth/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(400).send('Missing CLIENT_ID/CLIENT_SECRET');
  const url = authURL();
  console.log('[AUTH] redirecting to', url);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  console.log('[CALLBACK] hit', { hasCode: !!code, state, url: req.originalUrl, proto: req.headers['x-forwarded-proto'] });
  if (!code) {
    return res
      .status(400)
      .type('text/html')
      .send(`<h1>Callback reached but no ?code</h1><p>URL: ${escapeHtml(req.originalUrl)}</p><p>Check Twitch Redirect URL & PUBLIC_URL.</p>`);
  }
  try {
    const tok = await exchangeCodeForToken(code);
    const info = await getUserInfo(tok.access_token);
    const data = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      obtained_at: Date.now(),
      scope: tok.scope,
      broadcaster_login: (info && info.login || '').toLowerCase(),
      broadcaster_id: info && info.id
    };
    await store.saveTokens(data);
    await startEventSubWithTokens(data);
    res
      .status(200)
      .type('text/html')
      .send('<h1>Auth successful ✅</h1><p>You can close this window.</p>');
  } catch (e) {
    console.error('[AUTH] error', e);
    res.status(500).type('text/html').send(`<h1>Auth error</h1><pre>${escapeHtml(e.message)}</pre>`);
  }
});

app.get('/api/karma', async (req, res) => res.json(await store.getAll()));
app.get('/api/karma/pending', async (req, res) => res.json(await store.pendingAll()));
app.get('/api/karma/:user', async (req, res) => res.json({ user: req.params.user, value: await store.getUser(req.params.user) }));

app.use('/overlay', express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log(`HTTP + Socket.IO on port ${PORT}`);
  boot().catch(e => console.error('[BOOT] error', e));
});

/* ========== Boot ========== */
let eventsub = null;
async function boot() {
  let tokens = await store.loadTokens();
  if (!tokens) {
    console.log(`Open ${redirectUri()} /auth/login to authorize.`);
    return;
  }
  if (tokens.refresh_token) {
    try {
      const rt = await refreshToken(tokens.refresh_token);
      tokens.access_token = rt.access_token;
      tokens.refresh_token = rt.refresh_token || tokens.refresh_token;
      await store.saveTokens(tokens);
    } catch (e) {
      console.warn('[BOOT] Refresh failed, requiring re-auth:', e.message);
      console.log(`Open ${redirectUri()} /auth/login to authorize.`);
      return;
    }
  }
  await startEventSubWithTokens(tokens);
}

async function startEventSubWithTokens(tokens) {
  const info = await getUserInfo(tokens.access_token);
  const bId = info.id;
  console.log('[BOOT] EventSub for broadcaster', info.login, `(${bId})`);
  if (eventsub) eventsub.stop();
  eventsub = new EventSubWS({ accessToken: tokens.access_token, broadcasterId: bId });
  eventsub.start();
}

/* ========== Helpers ========== */
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
