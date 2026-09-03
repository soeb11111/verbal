// db.js — PostgreSQL access layer, idempotent schema, plan presets, helpers.
//
// Works against two backends with the same query() interface:
//   * production/dev: node-postgres Pool (via DATABASE_URL)
//   * tests:          PGlite (PostgreSQL compiled to WASM), injected with useAdapter()
//
// No ORM. Plain SQL with $1 placeholders (compatible with both backends).

const { Pool, types } = require('pg');

// Return raw strings for timestamp columns from node-postgres so formatting is
// consistent regardless of the machine timezone (1114 = timestamp, 1184 = timestamptz).
try {
  types.setTypeParser(1114, (v) => v);
  types.setTypeParser(1184, (v) => v);
} catch (_) { /* ignore */ }

let pool = null;      // node-postgres Pool
let adapter = null;   // custom adapter (e.g. PGlite) exposing async query(text, params)

// ---- Plan presets ---------------------------------------------------------
const ALL_MODULES = ['inbox', 'contacts', 'broadcast', 'templates', 'automation'];

const PLANS = {
  trial:    { max_users: 3,   max_contacts: 500,    modules: ALL_MODULES.slice() },
  starter:  { max_users: 5,   max_contacts: 2000,   modules: ['inbox', 'contacts', 'templates'] },
  pro:      { max_users: 20,  max_contacts: 25000,  modules: ALL_MODULES.slice() },
  business: { max_users: 100, max_contacts: 250000, modules: ALL_MODULES.slice() },
};

const STAGES = ['New Lead', 'Qualified', 'Negotiation', 'Won', 'Cold'];
const ROLES = ['owner', 'admin', 'agent'];

// ---- Backend selection ----------------------------------------------------
function useAdapter(a) { adapter = a; }

function detectSSL(url) {
  const override = (process.env.PGSSL || '').toLowerCase();
  if (override === 'require') return { rejectUnauthorized: false };
  if (override === 'disable') return false;
  const u = String(url || '');
  if (/localhost|127\.0\.0\.1|\.railway\.internal|\.internal(?:[:/]|$)/.test(u)) return false;
  return { rejectUnauthorized: false };
}

function initPool() {
  if (pool || adapter) return;
  const url = process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: url,
    ssl: detectSSL(url),
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  });
}

// ---- Timestamp formatting -------------------------------------------------
// Normalise any *_at field to "YYYY-MM-DD HH:MM:SS.mmm" (UTC, milliseconds).
function fmtTs(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) {
    return v.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
  }
  let s = String(v).replace('T', ' ').replace('Z', '').trim();
  const dot = s.indexOf('.');
  if (dot === -1) {
    s = s + '.000';
  } else {
    const frac = (s.slice(dot + 1) + '000').slice(0, 3);
    s = s.slice(0, dot) + '.' + frac;
  }
  return s;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    if (k.endsWith('_at')) row[k] = fmtTs(row[k]);
  }
  return row;
}

// ---- Core query -----------------------------------------------------------
async function query(text, params) {
  let result;
  if (adapter) {
    result = await adapter.query(text, params || []);
  } else {
    if (!pool) initPool();
    result = await pool.query(text, params || []);
  }
  const rows = (result && result.rows) || [];
  for (const r of rows) normalizeRow(r);
  return { rows, rowCount: result && (result.rowCount != null ? result.rowCount : rows.length) };
}

async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

// ---- Schema (idempotent) --------------------------------------------------
// Swallow benign concurrency errors so multiple app instances can init at once.
const BENIGN_CODES = new Set(['23505', '42P07', '42710', '42P06', '42701']);
async function safe(sql) {
  try { await query(sql); }
  catch (e) {
    if (e && BENIGN_CODES.has(e.code)) return;
    if (e && /already exists|duplicate/i.test(String(e.message))) return;
    throw e;
  }
}

async function ensureSchema() {
  await safe(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      industry TEXT,
      country TEXT,
      logo_emoji TEXT DEFAULT '\ud83d\udcac',
      wa_token TEXT,
      wa_phone_id TEXT,
      wa_verify_token TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      plan TEXT NOT NULL DEFAULT 'trial',
      max_users INTEGER NOT NULL DEFAULT 3,
      max_contacts INTEGER NOT NULL DEFAULT 500,
      modules TEXT NOT NULL DEFAULT '["inbox","contacts","broadcast","templates","automation"]',
      notes TEXT DEFAULT '',
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      company TEXT,
      stage TEXT NOT NULL DEFAULT 'New Lead',
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT DEFAULT 'Manual',
      owner_user_id INTEGER,
      unread INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      last_direction TEXT,
      closed_at TIMESTAMP(3),
      last_message_at TIMESTAMP(3),
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      sent_by_user_id INTEGER,
      wa_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'demo',
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS templates (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'MARKETING',
      status TEXT NOT NULL DEFAULT 'pending',
      body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      template_id INTEGER,
      segment TEXT,
      audience INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS bot_rules (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'keyword',
      keyword TEXT,
      reply TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      runs INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS quick_replies (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      shortcut TEXT,
      created_by INTEGER,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      id INTEGER PRIMARY KEY,
      registration_open BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMP(3) NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
  `);

  // Idempotent column top-ups (safe if the tables predate a column).
  const alters = [
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_direction TEXT`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP(3)`,
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_message_id TEXT`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP(3)`,
  ];
  for (const a of alters) { try { await query(a); } catch (_) {} }

  // Indexes
  const idx = [
    `CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_company_status ON contacts(company_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_quick_replies_company ON quick_replies(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON campaigns(status, scheduled_at)`,
  ];
  for (const i of idx) { try { await query(i); } catch (_) {} }

  // Ensure the singleton settings row exists.
  await query(
    `INSERT INTO platform_settings (id, registration_open) VALUES (1, FALSE)
     ON CONFLICT (id) DO NOTHING`
  );
}

// Seed default content for a newly created company (welcome bot + a quick reply).
async function seedCompanyDefaults(companyId) {
  await query(
    `INSERT INTO bot_rules (company_id, name, trigger_type, keyword, reply, active)
     VALUES ($1, 'Welcome bot', 'welcome', NULL, $2, TRUE)`,
    [companyId, "\ud83e\udd16 Hi {name}! Thanks for reaching out. How can we help you today?"]
  );
  await query(
    `INSERT INTO quick_replies (company_id, title, body, shortcut, created_by)
     VALUES ($1, 'Greeting', $2, 'hi', NULL)`,
    [companyId, 'Hi {name}, thanks for your message! How can we help you today?']
  );
}

module.exports = {
  query,
  one,
  ensureSchema,
  seedCompanyDefaults,
  useAdapter,
  PLANS,
  ALL_MODULES,
  STAGES,
  ROLES,
  fmtTs,
};
