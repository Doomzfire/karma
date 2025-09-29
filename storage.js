import fs from 'fs';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;

export async function createStore({ __dirname, DATABASE_URL }) {
  if (DATABASE_URL) {
    const pg = new PgStore(DATABASE_URL);
    await pg.init();
    return pg;
  } else {
    const json = new JsonStore(path.join(__dirname, 'karma.json'), path.join(__dirname, 'tokens.json'), path.join(__dirname, 'pending.json'));
    await json.init();
    return json;
  }
}

class JsonStore {
  constructor(karmaPath, tokensPath, pendingPath) {
    this.karmaPath = karmaPath;
    this.tokensPath = tokensPath;
    this.pendingPath = pendingPath;
    this.data = { users: {}, totalChanges: 0 };
    this.tokens = null;
    this.pending = { byId: {} };
  }
  async init() {
    try {
      if (fs.existsSync(this.karmaPath)) this.data = JSON.parse(fs.readFileSync(this.karmaPath, 'utf8'));
      if (fs.existsSync(this.tokensPath)) this.tokens = JSON.parse(fs.readFileSync(this.tokensPath, 'utf8'));
      if (fs.existsSync(this.pendingPath)) this.pending = JSON.parse(fs.readFileSync(this.pendingPath, 'utf8'));
    } catch(e){ console.error('[JsonStore] init', e); }
  }
  async _saveKarma(){ fs.writeFileSync(this.karmaPath, JSON.stringify(this.data, null, 2)); }
  async _saveTokens(){ fs.writeFileSync(this.tokensPath, JSON.stringify(this.tokens || {}, null, 2)); }
  async _savePending(){ fs.writeFileSync(this.pendingPath, JSON.stringify(this.pending || {byId:{}}, null, 2)); }

  async getAll(){ return this.data.users; }
  async getUser(user){ return this.data.users[user] || 0; }
  async applyDelta(user, delta) {
    const u = user.trim();
    const current = await this.getUser(u);
    const next = Math.max(-5, Math.min(5, current + delta));
    this.data.users[u] = next;
    this.data.totalChanges = (this.data.totalChanges || 0) + 1;
    await this._saveKarma();
    return next;
  }
  async setUser(user, value) {
    const u = user.trim();
    const v = Math.max(-5, Math.min(5, parseInt(value, 10) || 0));
    this.data.users[u] = v;
    this.data.totalChanges = (this.data.totalChanges || 0) + 1;
    await this._saveKarma();
    return v;
  }

  async saveTokens(obj){ this.tokens = obj; await this._saveTokens(); }
  async loadTokens(){ return this.tokens; }

  // Pending
  async pendingAdd(rec){ this.pending.byId[rec.id] = rec; await this._savePending(); }
  async pendingGet(id){ return this.pending.byId[id]; }
  async pendingAll(){ return this.pending.byId; }
  async pendingDelete(id){ delete this.pending.byId[id]; await this._savePending(); }
}

class PgStore {
  constructor(DATABASE_URL){
    this.pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined });
  }
  async init(){
    await this.pool.query(`
      create table if not exists karma (
        user_name text primary key,
        value numeric(10.3) not null default 0
      );
    `);
    await this.pool.query(`
      create table if not exists tokens (
        id int primary key default 1,
        data jsonb not null
      );
    `);
    await this.pool.query(`
      create table if not exists pending (
        id text primary key,
        user_name text not null,
        title text not null,
        delta integer not null,
        reward_id text,
        broadcaster_id text,
        at bigint,
        status text
      );
    `);
  }
  async getAll(){
    const r = await this.pool.query('select user_name, value from karma');
    const out = {};
    for (const row of r.rows) out[row.user_name] = row.value;
    return out;
  }
  async getUser(user){
    const r = await this.pool.query('select value from karma where user_name=$1', [user]);
    return r.rows[0]?.value || 0;
  }
  async applyDelta(user, delta){
    const r = await this.pool.query(
      `insert into karma (user_name, value) values ($1, greatest(-5, least(5, $2)))
       on conflict (user_name) do update set value = greatest(-5, least(5, karma.value + $2))
       returning value`,
      [user, delta]
    );
    return r.rows[0].value;
  }
  async setUser(user, value){
    const v = Math.max(-5, Math.min(5, parseFloat(value) || 0));
    await this.pool.query(
      `insert into karma (user_name, value) values ($1, $2)
       on conflict (user_name) do update set value = excluded.value`,
      [user, v]
    );
    return v;
  }
  async saveTokens(obj){
    await this.pool.query(
      `insert into tokens (id, data) values (1, $1)
       on conflict (id) do update set data = excluded.data`,
      [obj]
    );
  }
  async loadTokens(){
    const r = await this.pool.query('select data from tokens where id=1');
    return r.rows[0]?.data || null;
  }
  // Pending
  async pendingAdd(rec){
    await this.pool.query(
      `insert into pending (id, user_name, title, delta, reward_id, broadcaster_id, at, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set user_name=excluded.user_name, title=excluded.title, delta=excluded.delta, reward_id=excluded.reward_id, broadcaster_id=excluded.broadcaster_id, at=excluded.at, status=excluded.status`,
      [rec.id, rec.user, rec.title, rec.delta, rec.reward_id, rec.broadcaster_id, rec.at, rec.status]
    );
  }
  async pendingGet(id){
    const r = await this.pool.query('select * from pending where id=$1', [id]);
    return r.rows[0] && {
      id: r.rows[0].id,
      user: r.rows[0].user_name,
      title: r.rows[0].title,
      delta: r.rows[0].delta,
      reward_id: r.rows[0].reward_id,
      broadcaster_id: r.rows[0].broadcaster_id,
      at: r.rows[0].at,
      status: r.rows[0].status
    };
  }
  async pendingAll(){
    const r = await this.pool.query('select * from pending order by at asc');
    const out = {};
    for (const row of r.rows) {
      out[row.id] = {
        user: row.user_name, title: row.title, delta: row.delta,
        reward_id: row.reward_id, broadcaster_id: row.broadcaster_id,
        at: row.at, status: row.status
      };
    }
    return out;
  }
  async pendingDelete(id){ await this.pool.query('delete from pending where id=$1', [id]); }
}
