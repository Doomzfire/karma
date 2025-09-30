import { createClient } from '@supabase/supabase-js';

export async function createSupabaseStore() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase URL or Service Role Key missing');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  return new SupabaseStore(supabase);
}

class SupabaseStore {
  constructor(supabase) {
    this.supabase = supabase;
  }

  // Karma
  async getAll() {
    const { data } = await this.supabase.from('karma').select('user_name,value');
    const out = {};
    data.forEach(row => out[row.user_name] = row.value);
    return out;
  }

  async getUser(user) {
    const { data } = await this.supabase.from('karma').select('value').eq('user_name', user).single();
    return data?.value || 0;
  }

  async applyDelta(user, delta) {
    const current = await this.getUser(user);
    let next = Math.max(-25, Math.min(25, current + delta));
    next = Math.round(next * 100000) / 100000;
    await this.supabase.from('karma').upsert({ user_name: user, value: next });
    return next;
  }

  async setUser(user, value) {
    let v = Math.max(-25, Math.min(25, value));
    v = Math.round(v * 100000) / 100000;
    await this.supabase.from('karma').upsert({ user_name: user, value: v });
    return v;
  }

  // Tokens
  async saveTokens(obj) {
    await this.supabase.from('tokens').upsert({ id: 1, data: obj });
  }

  async loadTokens() {
    const { data } = await this.supabase.from('tokens').select('data').eq('id', 1).single();
    return data?.data || null;
  }

  // Pending
  async pendingAdd(rec) {
    await this.supabase.from('pending').upsert({
      id: rec.id,
      user_name: rec.user,
      title: rec.title,
      delta: rec.delta,
      reward_id: rec.reward_id,
      broadcaster_id: rec.broadcaster_id,
      at: rec.at,
      status: rec.status
    });
  }

  async pendingGet(id) {
    const { data } = await this.supabase.from('pending').select('*').eq('id', id).single();
    if (!data) return null;
    return {
      id: data.id,
      user: data.user_name,
      title: data.title,
      delta: data.delta,
      reward_id: data.reward_id,
      broadcaster_id: data.broadcaster_id,
      at: data.at,
      status: data.status
    };
  }

  async pendingAll() {
    const { data } = await this.supabase.from('pending').select('*').order('at', { ascending: true });
    const out = {};
    data.forEach(row => out[row.id] = {
      user: row.user_name,
      title: row.title,
      delta: row.delta,
      reward_id: row.reward_id,
      broadcaster_id: row.broadcaster_id,
      at: row.at,
      status: row.status
    });
    return out;
  }

  async pendingDelete(id) {
    await this.supabase.from('pending').delete().eq('id', id);
  }
}
