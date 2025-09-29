import pkg from 'pg';
const { Pool } = pkg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set in your environment.');
  process.exit(1);
}

async function migrate() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    console.log('🔹 Starting migration...');

    // Vérifie si la colonne delta existe et modifie son type en numeric(10,3)
    await pool.query(`
      ALTER TABLE pending
      ALTER COLUMN delta TYPE numeric(10,3) USING delta::numeric;
    `);

    console.log('✅ Migration complete! Column "delta" now supports decimals.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
