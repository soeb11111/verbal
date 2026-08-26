// db.js — PostgreSQL data layer (persistent; works on Vercel + Neon/Supabase/Railway)
//
// Requires DATABASE_URL. Get a free one at https://neon.tech
// Example: postgresql://user:pass@ep-xxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT DEFAULT '',
  country TEXT DEFAULT '',
  logo_emoji TEXT DEFAULT '💬',
  wa_token TEXT DEFAULT '',
  wa_phone_id TEXT DEFAULT '',
  wa_verify_token TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  company TEXT DEFAULT '',
  stage TEXT DEFAULT 'New Lead',
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'Manual',
  owner_user_id INTEGER,
  unread INTEGER DEFAULT 0,
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_by_user_id INTEGER,
  wa_message_id TEXT,
  status TEXT DEFAULT 'sent',
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Utility',
  status TEXT DEFAULT 'Pending Review',
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template_id INTEGER,
  segment TEXT DEFAULT 'All Contacts',
  audience INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0,
  delivered INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Draft',
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS bot_rules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  keyword TEXT DEFAULT '',
  reply TEXT NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  runs INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  registration_open BOOLEAN DEFAULT FALSE,
  CONSTRAINT single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  shortcut TEXT DEFAULT '',
  created_by INTEGER,
  uses INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Platform columns (added separately so existing databases upgrade cleanly)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'trial';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 3;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_contacts INTEGER DEFAULT 500;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS modules TEXT DEFAULT '["inbox","contacts","broadcast","templates","automation"]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';

-- Conversation state (inbox filters)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_direction TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(company_id, status);
CREATE INDEX IF NOT EXISTS idx_quick_replies_company ON quick_replies(company_id);

INSERT INTO platform_settings (id, registration_open) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;
`;

// Plan presets used by the super admin panel.
const PLANS = {
  trial:    { max_users: 3,   max_contacts: 500,    modules: ['inbox', 'contacts', 'broadcast', 'templates', 'automation'] },
  starter:  { max_users: 5,   max_contacts: 2000,   modules: ['inbox', 'contacts', 'templates'] },
  pro:      { max_users: 20,  max_contacts: 25000,  modules: ['inbox', 'contacts', 'broadcast', 'templates', 'automation'] },
  business: { max_users: 100, max_contacts: 250000, modules: ['inbox', 'contacts', 'broadcast', 'templates', 'automation'] },
};
const ALL_MODULES = ['inbox', 'contacts', 'broadcast', 'templates', 'automation'];

let driver = null;

function getDriver() {
  if (driver) return driver;

  // Test driver: PGlite (real Postgres via WASM) — used only by npm test
  if (process.env.PGLITE_TEST) {
    const { PGlite } = require('@electric-sql/pglite');
    const pg = new PGlite();
    driver = {
      query: (text, params) => pg.query(text, params),
      exec: (text) => pg.exec(text), // multi-statement (schema)
    };
    return driver;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Create a free Postgres database at https://neon.tech ' +
      'and add its connection string as the DATABASE_URL environment variable.'
    );
  }

  const { Pool, types } = require('pg');
  // Return timestamps as plain strings ("2026-08-20 12:34:56.789") instead of Date
  // objects, so the API and front-end can slice them directly.
  types.setTypeParser(1114, (v) => v);

  const url = process.env.DATABASE_URL;

  // SSL rules differ by host:
  //  - localhost / 127.0.0.1        → plain connection
  //  - *.railway.internal           → private network, SSL not offered
  //  - Neon, Supabase, public hosts → SSL required
  // Override with PGSSL=require or PGSSL=disable if your host differs.
  const privateHost = /@(localhost|127\.0\.0\.1|[^/@]*\.railway\.internal|[^/@]*\.internal)([:/]|$)/.test(url);
  let ssl = privateHost ? false : { rejectUnauthorized: false };
  if (process.env.PGSSL === 'disable') ssl = false;
  if (process.env.PGSSL === 'require') ssl = { rejectUnauthorized: false };

  const pool = new Pool({
    connectionString: url,
    ssl,
    max: Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 3 : 10)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (e) => console.error('Postgres pool error:', e.message));
  driver = {
    query: (text, params) => pool.query(text, params),
    // No parameters → node-postgres uses the simple query protocol, which
    // allows multiple statements in one call.
    exec: (text) => pool.query(text),
  };
  return driver;
}

// Convert "?" placeholders to Postgres "$1, $2, ..."
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Different drivers return timestamps as Date or string; normalise to
// "YYYY-MM-DD HH:mm:ss.SSS" (UTC) so the API is consistent everywhere.
function normalise(rows) {
  if (!Array.isArray(rows)) return rows;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) {
      if (r[k] instanceof Date) r[k] = r[k].toISOString().replace('T', ' ').replace('Z', '');
    }
  }
  return rows;
}

async function query(sql, params = []) {
  const result = await getDriver().query(toPg(sql), params);
  normalise(result.rows);
  return result;
}

/** First matching row, or null. */
async function row(sql, ...params) {
  const r = await query(sql, params);
  return r.rows[0] || null;
}

/** All matching rows. */
async function all(sql, ...params) {
  const r = await query(sql, params);
  return r.rows;
}

/** Execute a statement. Use "RETURNING id" and read result.id for inserts. */
async function run(sql, ...params) {
  const r = await query(sql, params);
  return { rows: r.rows, id: r.rows?.[0]?.id ?? null, rowCount: r.rowCount };
}

// Create tables on first use (idempotent, runs once per process).
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = getDriver()
      .exec(SCHEMA)
      .catch((e) => {
        schemaPromise = null; // allow retry on next request
        throw e;
      });
  }
  return schemaPromise;
}

module.exports = { query, row, all, run, ensureSchema, SCHEMA, PLANS, ALL_MODULES };
