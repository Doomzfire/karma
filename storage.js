class PgStore {
  constructor(DATABASE_URL){
    this.pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }

  async init() {
    // Karma : valeur flottante
    await this.pool.query(`
      create table if not exists karma (
        user_name text primary key,
        value numeric(10,3) not null default 0
      );
    `);

    await this.pool.query(`
      create table if not exists tokens (
        id int primary key default 1,
        data jsonb not null
      );
    `);

    // Pending : delta flottant
    await this.pool.query(`
      create table if not exists pending (
        id text primary key,
        user_name text not null,
        title text not null,
        delta numeric(10,3) not null,
        reward_id text,
        broadcaster_id text,
        at bigint,
        status text
      );
    `);
  }

  async getAll() {
    const r = await this.pool.query('select user_name, value from karma');
    const out = {};
    for (const row of r.rows) out[row.user_name] = parseFloat(row.value);
    return out;
  }

  async getUser(user) {
    const r = await this.pool.query('select value from karma where user_name=$1', [user]);
    return parseFloat(r.rows[0]?.value) || 0;
  }

  async applyDelta(user, delta) {
    const d = parseFloat(delta); // forcer delta en nombre
    const r = await this.pool.query(
      `insert into karma (user_name, value) 
       values ($1, greatest(-5.0, least(5.0, $2)))
       on conflict (user_name) 
       do update set value = greatest(-5.0, least(5.0, karma.value + $2))
       returning value`,
      [user, d]
    );
    return parseFloat(r.rows[0].value);
  }

  async setUser(user, value) {
    const v = Math.max(-5, Math.min(5, Number(value) || 0));
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

  async loadTokens() {
    const r = await this.pool.query('select data from tokens where id=1');
    return r.rows[0]?.data || null;
  }

  // Pending
  async pendingAdd(rec){
    // ⚠️ Forcer delta en nombre pour éviter l'erreur Postgres
    if (typeof rec.delta === 'string') rec.delta = parseFloat(rec.delta);

    await this.pool.query(
      `insert into pending (id, user_name, title, delta, reward_id, broadcaster_id, at, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set 
         user_name=excluded.user_name, 
         title=excluded.title, 
         delta=excluded.delta, 
         reward_id=excluded.reward_id, 
         broadcaster_id=excluded.broadcaster_id, 
         at=excluded.at, 
         status=excluded.status`,
      [rec.id, rec.user, rec.title, rec.delta, rec.reward_id, rec.broadcaster_id, rec.at, rec.status]
    );
  }

  async pendingGet(id){
    const r = await this.pool.query('select * from pending where id=$1', [id]);
    return r.rows[0] && {
      id: r.rows[0].id,
      user: r.rows[0].user_name,
      title: r.rows[0].title,
      delta: parseFloat(r.rows[0].delta),
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
        user: row.user_name,
        title: row.title,
        delta: parseFloat(row.delta),
        reward_id: row.reward_id,
        broadcaster_id: row.broadcaster_id,
        at: row.at,
        status: row.status
      };
    }
    return out;
  }

  async pendingDelete(id){ 
    await this.pool.query('delete from pending where id=$1', [id]); 
  }
}
