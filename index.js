import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import fetch from 'node-fetch';
import { WebSocket as WS } from 'ws';
import fs from 'fs';
import path from 'path';
import url from 'url';
import crypto from 'crypto';
import { createStore } from './storage.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

/* ───────────────────────── .env (local) ───────────────────────── */
const dotenvPath = path.join(__dirname, '.env');
if (fs.existsSync(dotenvPath)) {
  const lines = fs.readFileSync(dotenvPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) process.env[m[1]] = m[2];
  }
}

/* ───────────────────────── Config ───────────────────────── */
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BROADCASTER_LOGIN = (process.env.BROADCASTER_LOGIN || '').toLowerCase();
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL = process.env.DATABASE_URL || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/,'');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // enable admin API

/* ───────────────────────── Reward mapping ───────────────────────── */
const norm = (s) => (s || '').toString().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const stripEmoji = (s) => s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
const DEFAULT_REWARD_MAP = {
  "heal💓": 0.250, "heal": 0.250,
  "eat🍏": 0.150, "eat": 0.150,
  "hydrate💧": 0.100, "hydrate": 0.100,
  "🔥👋A Hello!👋🔥": 0.050, "hello": 0.050,
  "bleed🩸": -0.250, "bleed": -0.250,
  "thirst🥵": -0.150, "thirst": -0.150,
  "hunger🦴": -0.100, "hunger": -0.100
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
try { if (process.env.REWARD_MAP_JSON) RAW_REWARD_MAP = JSON.parse(process.env.REWARD_MAP_JSON); } catch {}
const REWARD_MAP = buildNormalizedMap(RAW_REWARD_MAP);

/* ───────────────────────── Stores ───────────────────────── */
const store = await createStore({ __dirname, DATABASE_URL });
await store.init();

/* ───────────────────────── Helpers ───────────────────────── */
async function fetchJSON(urlStr, options = {}) {
  const res = await fetch(urlStr, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}
function redirectUri() {
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  return `${base}/auth/callback`
}

/* ───────────────────────── OAuth with state ───────────────────────── */
const SCOPES = ['channel:read:redemptions'];
const stateStore = new Map(); // state -> expiresAt
function makeState() {
  const s = crypto.randomBytes(16).toString('hex');
  stateStore.set(s, Date.now() + 10 * 60 * 1000);
  return s;
}
function isStateValid(s) {
  const exp = stateStore.get(s);
  if (!exp) return false;
  stateStore.delete(s);
  return exp > Date.now();
}
function authURL() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: makeState()
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

/* ───────────────────────── EventSub WS ───────────────────────── */
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
    this.ws = new WS(url);
    this.ws.on('open', () => console.log('[EventSub] connected'));
    this.ws.on('close', () => setTimeout(() => this.connect(this.reconnectUrl || this.url), 1500));
    this.ws.on('error', (err) => console.error('[EventSub] error', err.message));
    this.ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const t = data?.metadata?.message_type;

        if (t === 'session_welcome') {
          this.sessionId = data?.payload?.session?.id;
          await this.ensureSubscriptions();
        } else if (t === 'session_reconnect') {
          this.reconnectUrl = data?.payload?.session?.reconnect_url;
          this.stop(); this.connect(this.reconnectUrl);
        } else if (t === 'notification') {
          const type = data?.metadata?.subscription_type;
          const event = data?.payload?.event;

          if (type === 'channel.channel_points_custom_reward_redemption.add') {
            const key = norm(event?.reward?.title || '');
            const delta = REWARD_MAP[key] ?? REWARD_MAP[stripEmoji(key)] ?? 0;
            if (!delta) return;
            await store.pendingAdd({
              id: event?.id,
              user: event?.user_name || event?.user_login || 'unknown',
              title: event?.reward?.title || '',
              delta,
              reward_id: event?.reward?.id,
              broadcaster_id: this.broadcasterId,
              at: Date.now(),
              status: 'UNFULFILLED'
            });
          }

          if (type === 'channel.channel_points_custom_reward_redemption.update') {
            const redId = event?.id;
            const status = (event?.status || '').toUpperCase();
            const rec = await store.pendingGet(redId);
            if (!rec) return;
            if (status === 'FULFILLED') {
              const value = await store.applyDelta(rec.user, rec.delta);
              broadcastUpdate(rec.user, value, rec.delta, `reward:${rec.title}`);
              await store.pendingDelete(redId);
            } else if (status === 'CANCELED') {
              await store.pendingDelete(redId);
            }
          }
        }
      } catch (e) {
        console.error('[EventSub] parse', e.message);
      }
    });
  }

  async ensureSubscriptions() {
    if (!this.sessionId) return;
    try {
      const exist = await this.apiListSubs();
      const toDelete = (exist.data || []).filter(s =>
        ['channel.channel_points_custom_reward_redemption.add','channel.channel_points_custom_reward_redemption.update']
          .includes(s.type) && s.transport?.method === 'websocket'
      );
      for (const s of toDelete) await this.apiDeleteSub(s.id);
    } catch (e) { /* ignore */ }

    await this.apiCreateSub('channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: this.broadcasterId });
    await this.apiCreateSub('channel.channel_points_custom_reward_redemption.update', '1', { broadcaster_user_id: this.broadcasterId });
    console.log('[EventSub] subscriptions ready');
  }
  async apiCreateSub(type, version, condition) {
    const body = { type, version, condition, transport: { method: 'websocket', session_id: this.sessionId } };
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
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

/* ───────────────────────── App & CORS ───────────────────────── */
const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.length ? origin : '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

/* ───────────────────────── Socket.IO (DECLARE ONCE) ───────────────────────── */
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*' } });
function broadcastUpdate(user, value, delta, source) {
  io.emit('karma:update', { user, value, delta, source, at: Date.now() });
  console.log(`[karma] ${user} ${delta >= 0 ? '+' : ''}${delta} -> ${value} (${source})`);
}

/* ───────────────────────── Routes (public) ───────────────────────── */
app.get('/health', (req, res) => res.type('text/plain').send('ok'));
app.get('/', (req, res) => res.type('text/plain').send('Doomz Karma Service (prod + admin)'));
app.get('/auth/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(400).send('Missing CLIENT_ID/CLIENT_SECRET');
  res.redirect(authURL());
});
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).type('text/html').send('<h1>Missing code</h1>');
  if (!isStateValid(state)) return res.status(400).type('text/html').send('<h1>Invalid state</h1>');
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
    res.type('text/html').send('<h1>Auth successful</h1>');
  } catch (e) {
    console.error('[auth]', e.message);
    res.status(500).type('text/html').send('<h1>Auth error</h1>');
  }
});
app.get('/api/karma', async (req, res) => res.json(await store.getAll()));
app.get('/api/karma/pending', async (req, res) => res.json(await store.pendingAll()));
app.get('/api/karma/:user', async (req, res) => res.json({ user: req.params.user, value: await store.getUser(req.params.user) }));
app.use('/overlay', express.static(path.join(__dirname, 'public')));

/* ───────────────────────── Admin middleware ───────────────────────── */
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin API disabled (set ADMIN_KEY env var)' });
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ───────────────────────── Admin endpoints ───────────────────────── */
app.post('/api/admin/karma/reset/:user', requireAdmin, async (req, res) => {
  const user = req.params.user;
  const current = await store.getUser(user);
  const delta = -current;
  if (delta !== 0) {
    const value = await store.applyDelta(user, delta);
    broadcastUpdate(user, value, delta, 'admin:reset');
    return res.json({ user, value, delta });
  }
  res.json({ user, value: current, delta: 0 });
});

app.post('/api/admin/karma/set/:user', requireAdmin, async (req, res) => {
  const user = req.params.user;
  let value = Number(req.body?.value);
  if (!Number.isFinite(value)) return res.status(400).json({ error: 'Body { value:number } required' });
  const current = await store.getUser(user);
  const delta = value - current;
  if (delta !== 0) {
    const newVal = await store.applyDelta(user, delta);
    broadcastUpdate(user, newVal, delta, 'admin:set');
    return res.json({ user, value: newVal, delta });
  }
  res.json({ user, value: current, delta: 0 });
});

app.post('/api/admin/karma/add/:user', requireAdmin, async (req, res) => {
  const user = req.params.user;
  let delta = Number(req.body?.delta);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'Body { delta:number (non-zero) } required' });
  const value = await store.applyDelta(user, delta);
  broadcastUpdate(user, value, delta, 'admin:add');
  res.json({ user, value, delta });
});

/* ───────────────────────── Boot + Listen ───────────────────────── */
let eventsub = null;
async function boot() {
  let tokens = await store.loadTokens();
  if (!tokens) { console.log('Authorize at', redirectUri(), '/auth/login'); return; }
  if (tokens.refresh_token) {
    try {
      const rt = await refreshToken(tokens.refresh_token);
      tokens.access_token = rt.access_token;
      tokens.refresh_token = rt.refresh_token || tokens.refresh_token;
      await store.saveTokens(tokens);
    } catch (e) {
      console.warn('[boot] refresh failed:', e.message);
      console.log('Re-authorize at', redirectUri(), '/auth/login');
      return;
    }
  }
  await startEventSubWithTokens(tokens);
}
async function startEventSubWithTokens(tokens) {
  const info = await getUserInfo(tokens.access_token);
  const bId = info.id;
  console.log('[boot] EventSub for', info.login, `(${bId})`);
  if (eventsub) eventsub.stop();
  eventsub = new EventSubWS({ accessToken: tokens.access_token, broadcasterId: bId });
  eventsub.start();
}

server.listen(PORT, () => {
  console.log(`HTTP + Socket.IO on port ${PORT}`);
  boot().catch(e => console.error('[boot]', e.message));
});
