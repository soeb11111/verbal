// server.js — Verbal multi-tenant WhatsApp CRM. Express app + all routes.
// Entry point. Exports the app so tests can mount it in-process.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const wa = require('./whatsapp');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();

function resolveJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 32) return s;
  if (IS_PROD) return null; // handled by setup gate
  const gen = crypto.randomBytes(48).toString('hex');
  console.warn('[verbal] JWT_SECRET not set (or <32 chars); generated a random dev secret. Sessions reset on restart.');
  return gen;
}
const JWT_SECRET = resolveJwtSecret();

function missingProdVars() {
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) missing.push('JWT_SECRET (32+ chars)');
  return missing;
}

// ---------------------------------------------------------------------------
// Setup gate — must run BEFORE static files. In production, if critical env
// vars are missing, every request returns a "Setup required" page.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (!IS_PROD) return next();
  const missing = missingProdVars();
  if (missing.length === 0) return next();
  res.status(503).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
    <title>Setup required — Verbal</title>
    <style>body{font-family:system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 20px;color:#111827}
    h1{font-size:20px} code{background:#f3f4f6;padding:2px 6px;border-radius:4px} li{margin:8px 0}
    .b{color:#0f766e}</style></head>
    <body><h1><span class="b">Verbal</span> — setup required</h1>
    <p>The application cannot start until these environment variables are configured:</p>
    <ul>${missing.map((m) => `<li><code>${m}</code></li>`).join('')}</ul>
    <p>Set them on your host and redeploy.</p></body></html>`);
});

// ---------------------------------------------------------------------------
// One-time schema initialisation (idempotent) on first request after startup.
// ---------------------------------------------------------------------------
let schemaReady = null;
async function ensureReady() {
  if (!schemaReady) {
    schemaReady = db.ensureSchema().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
app.use(async (req, res, next) => {
  try { await ensureReady(); next(); }
  catch (e) { console.error('[verbal] schema init failed:', e); res.status(500).json({ error: 'database unavailable' }); }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isSuperEmail(email) {
  return !!SUPER_ADMIN_EMAIL && String(email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL;
}
function signToken(user) {
  return jwt.sign({ uid: user.id, cid: user.company_id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}
function parseJSON(v, fallback) { try { return JSON.parse(v); } catch (_) { return fallback; } }
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, company_id: u.company_id, name: u.name, email: u.email, role: u.role, active: u.active, created_at: u.created_at };
}
function publicCompany(c) {
  if (!c) return null;
  return {
    id: c.id, name: c.name, industry: c.industry, country: c.country, logo_emoji: c.logo_emoji,
    status: c.status, plan: c.plan, max_users: c.max_users, max_contacts: c.max_contacts,
    modules: parseJSON(c.modules, []), notes: c.notes,
    wa_connected: !!(c.wa_token && c.wa_phone_id), wa_phone_id: c.wa_phone_id || null,
    wa_verify_token: c.wa_verify_token || null, created_at: c.created_at,
  };
}
function contactOut(c) {
  if (!c) return null;
  const o = Object.assign({}, c);
  o.tags = parseJSON(c.tags, []);
  return o;
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }
function personalize(text, contact) { return String(text || '').replace(/\{name\}/g, firstName(contact && contact.name)); }
function normalizeTemplateName(n) {
  return String(n || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'template';
}
function genPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = ''; const buf = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) s += chars[buf[i] % chars.length];
  return s;
}
function clientLoginUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}/`;
}
const MODULE_FOR = { templates: 'templates', campaigns: 'broadcast', bots: 'automation' };

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
async function auth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'authentication required' });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch (_) { return res.status(401).json({ error: 'invalid or expired session' }); }

    const user = await db.one('SELECT * FROM users WHERE id=$1', [payload.uid]);
    if (!user || !user.active) return res.status(401).json({ error: 'account is inactive' });
    const company = await db.one('SELECT * FROM companies WHERE id=$1', [user.company_id]);
    if (!company) return res.status(401).json({ error: 'workspace not found' });

    const superAdmin = isSuperEmail(user.email);
    if (company.status === 'suspended' && !superAdmin) {
      return res.status(403).json({ error: 'This workspace is suspended. Please contact support.' });
    }
    req.user = user;
    req.company = company;
    req.isSuper = superAdmin;
    req.modules = parseJSON(company.modules, []);
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.isSuper) return next();
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'insufficient permissions' });
    next();
  };
}
function requireModule(mod) {
  return (req, res, next) => {
    if (!req.modules.includes(mod)) return res.status(403).json({ error: `The ${mod} module is not enabled on your plan.` });
    next();
  };
}
function requireSuper(req, res, next) {
  if (!req.isSuper) return res.status(403).json({ error: 'platform owner only' });
  next();
}

// ===========================================================================
// PUBLIC ROUTES
// ===========================================================================
app.get('/api/health', async (req, res) => {
  try {
    const r = await db.one('SELECT COUNT(*)::int AS n FROM companies');
    res.json({ ok: true, database: 'up', companies: r ? r.n : 0 });
  } catch (e) {
    res.status(500).json({ ok: false, database: 'down', error: String(e.message || e) });
  }
});

app.get('/api/auth/config', async (req, res) => {
  const c = await db.one('SELECT COUNT(*)::int AS n FROM users');
  const s = await db.one('SELECT registration_open FROM platform_settings WHERE id=1');
  res.json({ registrationOpen: !!(s && s.registration_open), firstRun: !c || c.n === 0 });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { companyName, name, email, password } = req.body || {};
    if (!companyName || !name || !email || !password) return res.status(400).json({ error: 'companyName, name, email and password are required' });
    if (String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

    const userCount = (await db.one('SELECT COUNT(*)::int AS n FROM users')).n;
    const settings = await db.one('SELECT registration_open FROM platform_settings WHERE id=1');
    const allowed = userCount === 0 || isSuperEmail(email) || (settings && settings.registration_open);
    if (!allowed) return res.status(403).json({ error: 'Public sign-up is closed. Please contact your platform administrator.' });

    const existing = await db.one('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const preset = db.PLANS.trial;
    const company = await db.one(
      `INSERT INTO companies (name, plan, max_users, max_contacts, modules)
       VALUES ($1,'trial',$2,$3,$4) RETURNING *`,
      [companyName, preset.max_users, preset.max_contacts, JSON.stringify(preset.modules)]
    );
    const hash = await bcrypt.hash(String(password), 10);
    const user = await db.one(
      `INSERT INTO users (company_id, name, email, password_hash, role, active)
       VALUES ($1,$2,$3,$4,'owner',TRUE) RETURNING *`,
      [company.id, name, String(email).toLowerCase(), hash]
    );
    await db.seedCompanyDefaults(company.id);
    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user), company: publicCompany(company), isSuperAdmin: isSuperEmail(user.email) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const user = await db.one('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.active) return res.status(403).json({ error: 'This account is deactivated.' });
    const company = await db.one('SELECT * FROM companies WHERE id=$1', [user.company_id]);
    if (company.status === 'suspended' && !isSuperEmail(user.email)) {
      return res.status(403).json({ error: 'This workspace is suspended. Please contact support.' });
    }
    const token = signToken(user);
    res.json({ token, user: publicUser(user), company: publicCompany(company), isSuperAdmin: isSuperEmail(user.email) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'login failed' }); }
});

// ===========================================================================
// AUTHENTICATED ROUTES
// ===========================================================================
app.get('/api/me', auth, async (req, res) => {
  const usage = await workspaceUsage(req.company.id);
  res.json({
    user: publicUser(req.user),
    company: publicCompany(req.company),
    plan: db.PLANS[req.company.plan] || null,
    usage,
    modules: req.modules,
    isSuperAdmin: req.isSuper,
    webhookUrl: `${clientLoginUrl(req).replace(/\/$/, '')}/webhook/${req.company.id}`,
  });
});

async function workspaceUsage(companyId) {
  const u = await db.one('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1', [companyId]);
  const c = await db.one('SELECT COUNT(*)::int AS n FROM contacts WHERE company_id=$1', [companyId]);
  return { users: u.n, contacts: c.n };
}

// ---- Company profile + WhatsApp settings ---------------------------------
app.patch('/api/company', auth, requireRole('owner', 'admin'), async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  for (const f of ['name', 'industry', 'country', 'logo_emoji', 'wa_phone_id', 'wa_verify_token']) {
    if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
  }
  // wa_token is write-only: accept it, never echo it back.
  if (b.wa_token !== undefined && b.wa_token !== '') { sets.push(`wa_token=$${i++}`); vals.push(b.wa_token); }
  if (b.wa_token === null) { sets.push(`wa_token=NULL`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.company.id);
  const c = await db.one(`UPDATE companies SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ company: publicCompany(c) });
});

// ===========================================================================
// TEAM
// ===========================================================================
app.get('/api/users', auth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE company_id=$1 ORDER BY created_at ASC', [req.company.id]);
  res.json({ users: rows.map(publicUser) });
});

app.post('/api/users', auth, requireRole('owner', 'admin'), async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (!['admin', 'agent'].includes(role || 'agent')) return res.status(400).json({ error: 'role must be admin or agent' });

  const count = (await db.one('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1', [req.company.id])).n;
  if (count >= req.company.max_users) {
    return res.status(402).json({ error: `User limit reached (${count}/${req.company.max_users}). Upgrade your plan to add more team members.` });
  }
  const existing = await db.one('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
  const hash = await bcrypt.hash(String(password), 10);
  const user = await db.one(
    `INSERT INTO users (company_id, name, email, password_hash, role, active)
     VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *`,
    [req.company.id, name, String(email).toLowerCase(), hash, role || 'agent']
  );
  res.status(201).json({ user: publicUser(user) });
});

app.patch('/api/users/:id', auth, requireRole('owner', 'admin'), async (req, res) => {
  const target = await db.one('SELECT * FROM users WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'The owner account cannot be modified.' });
  const b = req.body || {};
  const sets = []; const vals = []; let i = 1;
  if (b.role !== undefined) {
    if (!['admin', 'agent'].includes(b.role)) return res.status(400).json({ error: 'role must be admin or agent' });
    sets.push(`role=$${i++}`); vals.push(b.role);
  }
  if (b.active !== undefined) { sets.push(`active=$${i++}`); vals.push(!!b.active); }
  if (b.name !== undefined) { sets.push(`name=$${i++}`); vals.push(b.name); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(target.id);
  const u = await db.one(`UPDATE users SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ user: publicUser(u) });
});

app.delete('/api/users/:id', auth, requireRole('owner', 'admin'), async (req, res) => {
  const target = await db.one('SELECT * FROM users WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'The owner account cannot be deleted.' });
  if (target.id === req.user.id) return res.status(403).json({ error: 'You cannot delete your own account.' });
  await db.query('DELETE FROM users WHERE id=$1', [target.id]);
  res.json({ ok: true });
});

// ===========================================================================
// INBOX + CONTACTS
// ===========================================================================
app.get('/api/inbox/counts', auth, async (req, res) => {
  const cid = req.company.id;
  const q = async (where, params) => (await db.one(`SELECT COUNT(*)::int AS n FROM contacts WHERE company_id=$1 ${where}`, [cid, ...(params || [])])).n;
  res.json({
    open: await q(`AND status='open'`),
    closed: await q(`AND status='closed'`),
    awaiting: await q(`AND status='open' AND last_direction='in'`),
    unread: await q(`AND unread>0`),
    mine: await q(`AND owner_user_id=$2`, [req.user.id]),
    unassigned: await q(`AND owner_user_id IS NULL`),
    all: await q(``),
  });
});

app.get('/api/contacts', auth, async (req, res) => {
  const cid = req.company.id;
  const { view, owner, tag, q, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
  const where = ['company_id=$1']; const params = [cid]; let i = 2;
  switch (view) {
    case 'open': where.push(`status='open'`); break;
    case 'closed': where.push(`status='closed'`); break;
    case 'awaiting': where.push(`status='open' AND last_direction='in'`); break;
    case 'unread': where.push(`unread>0`); break;
    case 'mine': where.push(`owner_user_id=$${i++}`); params.push(req.user.id); break;
    case 'unassigned': where.push(`owner_user_id IS NULL`); break;
    default: break; // 'all' or unset
  }
  if (owner) { where.push(`owner_user_id=$${i++}`); params.push(owner); }
  if (tag) { where.push(`tags LIKE $${i++}`); params.push(`%"${tag}"%`); }
  if (q) { where.push(`(name ILIKE $${i} OR phone ILIKE $${i} OR company ILIKE $${i})`); params.push(`%${q}%`); i++; }
  if (from) { where.push(`created_at >= $${i++}`); params.push(from); }
  if (to) { where.push(`created_at <= $${i++}`); params.push(to); }
  params.push(limit);
  const sql = `SELECT * FROM contacts WHERE ${where.join(' AND ')}
     ORDER BY (last_message_at IS NULL), last_message_at DESC, created_at DESC LIMIT $${i}`;
  const { rows } = await db.query(sql, params);
  res.json({ contacts: rows.map(contactOut) });
});

app.post('/api/contacts', auth, async (req, res) => {
  const { name, phone, company, stage, tags, owner_user_id, source } = req.body || {};
  if (!name && !phone) return res.status(400).json({ error: 'name or phone is required' });
  const count = (await db.one('SELECT COUNT(*)::int AS n FROM contacts WHERE company_id=$1', [req.company.id])).n;
  if (count >= req.company.max_contacts) {
    return res.status(402).json({ error: `Contact limit reached (${count}/${req.company.max_contacts}). Upgrade your plan to add more contacts.` });
  }
  const st = db.STAGES.includes(stage) ? stage : 'New Lead';
  const c = await db.one(
    `INSERT INTO contacts (company_id, name, phone, company, stage, tags, source, owner_user_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open') RETURNING *`,
    [req.company.id, name || phone, phone || null, company || null, st, JSON.stringify(Array.isArray(tags) ? tags : []), source || 'Manual', owner_user_id || null]
  );
  res.status(201).json({ contact: contactOut(c) });
});

app.patch('/api/contacts/:id', auth, async (req, res) => {
  const c = await db.one('SELECT * FROM contacts WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!c) return res.status(404).json({ error: 'contact not found' });
  const b = req.body || {}; const sets = []; const vals = []; let i = 1;
  for (const f of ['name', 'phone', 'company', 'source']) if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
  if (b.stage !== undefined) {
    if (!db.STAGES.includes(b.stage)) return res.status(400).json({ error: 'invalid stage' });
    sets.push(`stage=$${i++}`); vals.push(b.stage);
  }
  if (b.owner_user_id !== undefined) { sets.push(`owner_user_id=$${i++}`); vals.push(b.owner_user_id || null); }
  if (b.tags !== undefined) { sets.push(`tags=$${i++}`); vals.push(JSON.stringify(Array.isArray(b.tags) ? b.tags : [])); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(c.id);
  const up = await db.one(`UPDATE contacts SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ contact: contactOut(up) });
});

app.delete('/api/contacts/:id', auth, async (req, res) => {
  const c = await db.one('SELECT id FROM contacts WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!c) return res.status(404).json({ error: 'contact not found' });
  await db.query('DELETE FROM contacts WHERE id=$1', [c.id]);
  res.json({ ok: true });
});

app.post('/api/contacts/:id/status', auth, async (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be open or closed' });
  const c = await db.one('SELECT * FROM contacts WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!c) return res.status(404).json({ error: 'contact not found' });
  if (status === 'closed') {
    await db.query(`UPDATE contacts SET status='closed', closed_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, [c.id]);
    await addNote(req.company.id, c.id, 'Conversation resolved', req.user.id);
  } else {
    await db.query(`UPDATE contacts SET status='open', closed_at=NULL WHERE id=$1`, [c.id]);
    await addNote(req.company.id, c.id, 'Conversation reopened', req.user.id);
  }
  const up = await db.one('SELECT * FROM contacts WHERE id=$1', [c.id]);
  res.json({ contact: contactOut(up) });
});

async function addNote(companyId, contactId, body, userId) {
  return db.one(
    `INSERT INTO messages (company_id, contact_id, direction, body, sent_by_user_id, status)
     VALUES ($1,$2,'note',$3,$4,'demo') RETURNING *`,
    [companyId, contactId, body, userId || null]
  );
}

// ===========================================================================
// MESSAGES
// ===========================================================================
app.get('/api/messages/:contactId', auth, async (req, res) => {
  const c = await db.one('SELECT * FROM contacts WHERE id=$1 AND company_id=$2', [req.params.contactId, req.company.id]);
  if (!c) return res.status(404).json({ error: 'contact not found' });
  const { rows } = await db.query(
    `SELECT m.*, u.name AS sender_name FROM messages m
     LEFT JOIN users u ON u.id=m.sent_by_user_id
     WHERE m.contact_id=$1 ORDER BY m.created_at ASC, m.id ASC`, [c.id]);
  await db.query('UPDATE contacts SET unread=0 WHERE id=$1', [c.id]);
  res.json({ contact: contactOut(Object.assign({}, c, { unread: 0 })), messages: rows });
});

app.post('/api/messages/:contactId', auth, async (req, res) => {
  const { body, direction } = req.body || {};
  const dir = ['out', 'note'].includes(direction) ? direction : 'out';
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'message body is required' });
  const c = await db.one('SELECT * FROM contacts WHERE id=$1 AND company_id=$2', [req.params.contactId, req.company.id]);
  if (!c) return res.status(404).json({ error: 'contact not found' });

  if (dir === 'note') {
    const m = await addNote(req.company.id, c.id, String(body), req.user.id);
    return res.status(201).json({ message: m });
  }
  // Outbound human message
  let status = 'demo'; let waId = null;
  if (wa.isConfigured(req.company)) {
    const r = await wa.sendText(req.company, c.phone, String(body));
    if (r.demo) status = 'demo';
    else if (r.ok) { status = 'sent'; waId = r.wa_message_id || null; }
    else status = 'failed';
  }
  const m = await db.one(
    `INSERT INTO messages (company_id, contact_id, direction, body, sent_by_user_id, wa_message_id, status)
     VALUES ($1,$2,'out',$3,$4,$5,$6) RETURNING *`,
    [req.company.id, c.id, String(body), req.user.id, waId, status]
  );
  await db.query(
    `UPDATE contacts SET last_direction='out', last_message_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, [c.id]);
  const up = await db.one('SELECT * FROM contacts WHERE id=$1', [c.id]);
  res.status(201).json({ message: m, contact: contactOut(up) });
});

// ===========================================================================
// QUICK REPLIES
// ===========================================================================
app.get('/api/quick-replies', auth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM quick_replies WHERE company_id=$1 ORDER BY created_at ASC', [req.company.id]);
  res.json({ quickReplies: rows });
});
app.post('/api/quick-replies', auth, async (req, res) => {
  const { title, body, shortcut } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  const qr = await db.one(
    `INSERT INTO quick_replies (company_id, title, body, shortcut, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.company.id, title, body, shortcut || null, req.user.id]);
  res.status(201).json({ quickReply: qr });
});
app.patch('/api/quick-replies/:id', auth, async (req, res) => {
  const qr = await db.one('SELECT * FROM quick_replies WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!qr) return res.status(404).json({ error: 'quick reply not found' });
  const b = req.body || {};
  if (b.used) {
    const up = await db.one('UPDATE quick_replies SET uses=uses+1 WHERE id=$1 RETURNING *', [qr.id]);
    return res.json({ quickReply: up });
  }
  const sets = []; const vals = []; let i = 1;
  for (const f of ['title', 'body', 'shortcut']) if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(qr.id);
  const up = await db.one(`UPDATE quick_replies SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ quickReply: up });
});
app.delete('/api/quick-replies/:id', auth, async (req, res) => {
  const qr = await db.one('SELECT id FROM quick_replies WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!qr) return res.status(404).json({ error: 'quick reply not found' });
  await db.query('DELETE FROM quick_replies WHERE id=$1', [qr.id]);
  res.json({ ok: true });
});

// ===========================================================================
// TEMPLATES  (module: templates)
// ===========================================================================
app.get('/api/templates', auth, requireModule('templates'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM templates WHERE company_id=$1 ORDER BY created_at DESC', [req.company.id]);
  res.json({ templates: rows });
});
app.post('/api/templates', auth, requireModule('templates'), requireRole('owner', 'admin'), async (req, res) => {
  const { name, category, body } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
  const t = await db.one(
    `INSERT INTO templates (company_id, name, category, status, body) VALUES ($1,$2,$3,'pending',$4) RETURNING *`,
    [req.company.id, normalizeTemplateName(name), category || 'MARKETING', body]);
  res.status(201).json({ template: t });
});
app.patch('/api/templates/:id', auth, requireModule('templates'), requireRole('owner', 'admin'), async (req, res) => {
  const t = await db.one('SELECT * FROM templates WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!t) return res.status(404).json({ error: 'template not found' });
  const b = req.body || {}; const sets = []; const vals = []; let i = 1;
  if (b.name !== undefined) { sets.push(`name=$${i++}`); vals.push(normalizeTemplateName(b.name)); }
  if (b.category !== undefined) { sets.push(`category=$${i++}`); vals.push(b.category); }
  if (b.body !== undefined) { sets.push(`body=$${i++}`); vals.push(b.body); }
  if (b.status !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(b.status)) return res.status(400).json({ error: 'invalid status' });
    sets.push(`status=$${i++}`); vals.push(b.status);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(t.id);
  const up = await db.one(`UPDATE templates SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ template: up });
});
app.delete('/api/templates/:id', auth, requireModule('templates'), requireRole('owner', 'admin'), async (req, res) => {
  const t = await db.one('SELECT id FROM templates WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!t) return res.status(404).json({ error: 'template not found' });
  await db.query('DELETE FROM templates WHERE id=$1', [t.id]);
  res.json({ ok: true });
});

// ===========================================================================
// CAMPAIGNS / BROADCAST  (module: broadcast, admin only)
// ===========================================================================
app.get('/api/campaigns', auth, requireModule('broadcast'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, t.name AS template_name FROM campaigns c
     LEFT JOIN templates t ON t.id=c.template_id
     WHERE c.company_id=$1 ORDER BY c.created_at DESC`, [req.company.id]);
  res.json({ campaigns: rows });
});
app.post('/api/campaigns', auth, requireModule('broadcast'), requireRole('owner', 'admin'), async (req, res) => {
  const { name, template_id, segment } = req.body || {};
  if (!name || !template_id) return res.status(400).json({ error: 'name and template are required' });
  const tmpl = await db.one('SELECT * FROM templates WHERE id=$1 AND company_id=$2', [template_id, req.company.id]);
  if (!tmpl) return res.status(404).json({ error: 'template not found' });

  const segType = segment && segment.type ? segment.type : 'all';
  const segVal = segment && segment.value;
  let where = 'company_id=$1'; const params = [req.company.id]; let label = 'All contacts';
  if (segType === 'tag') { where += ' AND tags LIKE $2'; params.push(`%"${segVal}"%`); label = `Tag: ${segVal}`; }
  else if (segType === 'stage') { where += ' AND stage=$2'; params.push(segVal); label = `Stage: ${segVal}`; }
  const recipients = (await db.query(`SELECT * FROM contacts WHERE ${where}`, params)).rows;
  if (!recipients.length) return res.status(400).json({ error: 'The selected segment has no contacts. Choose a different segment.' });

  const configured = wa.isConfigured(req.company);
  let sent = 0; let delivered = 0; let failed = 0;
  for (const ct of recipients) {
    let status = 'demo'; let waId = null;
    if (configured) {
      const r = await wa.sendTemplate(req.company, ct.phone, tmpl.name);
      if (r.ok) { status = 'sent'; waId = r.wa_message_id || null; delivered++; sent++; }
      else { status = 'failed'; failed++; }
    } else { status = 'demo'; sent++; delivered++; }
    await db.query(
      `INSERT INTO messages (company_id, contact_id, direction, body, wa_message_id, status)
       VALUES ($1,$2,'out',$3,$4,$5)`, [req.company.id, ct.id, personalize(tmpl.body, ct), waId, status]);
    await db.query(`UPDATE contacts SET last_direction='out', last_message_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, [ct.id]);
  }
  const camp = await db.one(
    `INSERT INTO campaigns (company_id, name, template_id, segment, audience, sent, delivered, failed, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sent') RETURNING *`,
    [req.company.id, name, tmpl.id, label, recipients.length, sent, delivered, failed]);
  res.status(201).json({ campaign: Object.assign({}, camp, { template_name: tmpl.name }) });
});

// ===========================================================================
// BOTS  (module: automation)
// ===========================================================================
app.get('/api/bots', auth, requireModule('automation'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM bot_rules WHERE company_id=$1 ORDER BY created_at ASC', [req.company.id]);
  res.json({ bots: rows });
});
app.post('/api/bots', auth, requireModule('automation'), requireRole('owner', 'admin'), async (req, res) => {
  const { name, trigger_type, keyword, reply, active } = req.body || {};
  if (!name || !reply) return res.status(400).json({ error: 'name and reply are required' });
  const tt = ['welcome', 'keyword'].includes(trigger_type) ? trigger_type : 'keyword';
  if (tt === 'keyword' && !keyword) return res.status(400).json({ error: 'keyword is required for keyword triggers' });
  const b = await db.one(
    `INSERT INTO bot_rules (company_id, name, trigger_type, keyword, reply, active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.company.id, name, tt, tt === 'keyword' ? keyword : null, reply, active === undefined ? true : !!active]);
  res.status(201).json({ bot: b });
});
app.patch('/api/bots/:id', auth, requireModule('automation'), requireRole('owner', 'admin'), async (req, res) => {
  const bot = await db.one('SELECT * FROM bot_rules WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  const b = req.body || {}; const sets = []; const vals = []; let i = 1;
  for (const f of ['name', 'keyword', 'reply']) if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
  if (b.trigger_type !== undefined) {
    if (!['welcome', 'keyword'].includes(b.trigger_type)) return res.status(400).json({ error: 'invalid trigger_type' });
    sets.push(`trigger_type=$${i++}`); vals.push(b.trigger_type);
  }
  if (b.active !== undefined) { sets.push(`active=$${i++}`); vals.push(!!b.active); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(bot.id);
  const up = await db.one(`UPDATE bot_rules SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ bot: up });
});
app.delete('/api/bots/:id', auth, requireModule('automation'), requireRole('owner', 'admin'), async (req, res) => {
  const bot = await db.one('SELECT id FROM bot_rules WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  await db.query('DELETE FROM bot_rules WHERE id=$1', [bot.id]);
  res.json({ ok: true });
});

// ===========================================================================
// STATS (dashboard)
// ===========================================================================
app.get('/api/stats', auth, async (req, res) => {
  const cid = req.company.id;
  const contacts = (await db.one('SELECT COUNT(*)::int AS n FROM contacts WHERE company_id=$1', [cid])).n;
  const unread = (await db.one('SELECT COUNT(*)::int AS n FROM contacts WHERE company_id=$1 AND unread>0', [cid])).n;
  const msgs7 = (await db.one(`SELECT COUNT(*)::int AS n FROM messages WHERE company_id=$1 AND created_at >= (now() AT TIME ZONE 'utc') - interval '7 days'`, [cid])).n;
  const campaigns = (await db.one(`SELECT COUNT(*)::int AS n FROM campaigns WHERE company_id=$1 AND status='sent'`, [cid])).n;
  const activeUsers = (await db.one('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1 AND active=TRUE', [cid])).n;
  const botReplies = (await db.one('SELECT COALESCE(SUM(runs),0)::int AS n FROM bot_rules WHERE company_id=$1', [cid])).n;
  const stageRows = (await db.query('SELECT stage, COUNT(*)::int AS n FROM contacts WHERE company_id=$1 GROUP BY stage', [cid])).rows;
  const pipeline = {}; for (const s of db.STAGES) pipeline[s] = 0;
  for (const r of stageRows) pipeline[r.stage] = r.n;
  res.json({ contacts, unread, messages7d: msgs7, campaigns, activeUsers, botReplies, pipeline });
});

// ===========================================================================
// SIMULATE INCOMING (testing tool)
// ===========================================================================
app.post('/api/simulate-incoming', auth, async (req, res) => {
  const { phone, name, body } = req.body || {};
  if (!phone || !body) return res.status(400).json({ error: 'phone and body are required' });
  const result = await processInbound(req.company, { phone, name: name || phone, body, wa_message_id: 'demo_' + Date.now() });
  res.status(201).json(result);
});

// Shared inbound processing (webhook + simulate). Bypasses contact limit.
async function processInbound(company, { phone, name, body, wa_message_id }) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  let contact = await db.one(
    `SELECT * FROM contacts WHERE company_id=$1 AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=$2`,
    [company.id, digits]);
  let isNew = false;
  if (!contact) {
    isNew = true;
    contact = await db.one(
      `INSERT INTO contacts (company_id, name, phone, source, status, unread, last_direction, last_message_at)
       VALUES ($1,$2,$3,'WhatsApp Inbound','open',0,'in',(now() AT TIME ZONE 'utc')) RETURNING *`,
      [company.id, name || phone, phone]);
  }
  // Inbound message
  const msg = await db.one(
    `INSERT INTO messages (company_id, contact_id, direction, body, wa_message_id, status)
     VALUES ($1,$2,'in',$3,$4,'delivered') RETURNING *`,
    [company.id, contact.id, String(body), wa_message_id || null]);
  await db.query(
    `UPDATE contacts SET unread=unread+1, last_message_at=(now() AT TIME ZONE 'utc'),
       last_direction='in', status='open',
       closed_at=CASE WHEN status='closed' THEN NULL ELSE closed_at END
     WHERE id=$1`, [contact.id]);

  // Run bots (bot replies must NOT clear last_direction -> stays 'awaiting reply')
  const botReplies = await runBots(company, contact, String(body), isNew);
  const fresh = await db.one('SELECT * FROM contacts WHERE id=$1', [contact.id]);
  return { contact: contactOut(fresh), message: msg, isNew, botReplies };
}

async function runBots(company, contact, incomingBody, isNewContact) {
  const bots = (await db.query('SELECT * FROM bot_rules WHERE company_id=$1 AND active=TRUE ORDER BY id ASC', [company.id])).rows;
  const replies = [];
  const lower = String(incomingBody || '').toLowerCase();
  for (const b of bots) {
    let fire = false;
    if (b.trigger_type === 'welcome' && isNewContact) fire = true;
    else if (b.trigger_type === 'keyword' && b.keyword && lower.includes(String(b.keyword).toLowerCase())) fire = true;
    if (!fire) continue;
    const replyBody = personalize(b.reply, contact);
    let status = 'demo'; let waId = null;
    if (wa.isConfigured(company)) {
      const r = await wa.sendText(company, contact.phone, replyBody);
      if (r.ok) { status = 'sent'; waId = r.wa_message_id || null; } else if (!r.demo) status = 'failed';
    }
    const m = await db.one(
      `INSERT INTO messages (company_id, contact_id, direction, body, wa_message_id, status)
       VALUES ($1,$2,'out',$3,$4,$5) RETURNING *`,
      [company.id, contact.id, replyBody, waId, status]);
    // Update last_message_at but deliberately NOT last_direction.
    await db.query(`UPDATE contacts SET last_message_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, [contact.id]);
    await db.query('UPDATE bot_rules SET runs=runs+1 WHERE id=$1', [b.id]);
    replies.push(m);
  }
  return replies;
}

// ===========================================================================
// WEBHOOK (per company) — outside /api on purpose (Meta config)
// ===========================================================================
app.get('/webhook/:companyId', async (req, res) => {
  const company = await db.one('SELECT * FROM companies WHERE id=$1', [req.params.companyId]);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (company && mode === 'subscribe' && token && company.wa_verify_token && token === company.wa_verify_token) {
    return res.status(200).send(String(challenge || ''));
  }
  return res.sendStatus(403);
});

app.post('/webhook/:companyId', async (req, res) => {
  // Acknowledge immediately; process asynchronously.
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const company = await db.one('SELECT * FROM companies WHERE id=$1', [req.params.companyId]);
      if (!company || company.status === 'suspended') return;
      const body = req.body || {};
      const entries = body.entry || [];
      for (const entry of entries) {
        for (const change of (entry.changes || [])) {
          const value = change.value || {};
          const profiles = {};
          for (const c of (value.contacts || [])) {
            if (c.wa_id) profiles[c.wa_id] = c.profile && c.profile.name;
          }
          for (const m of (value.messages || [])) {
            const from = m.from;
            const text = m.text && m.text.body ? m.text.body : (m.button && m.button.text) || '[unsupported message]';
            await processInbound(company, { phone: from, name: profiles[from] || from, body: text, wa_message_id: m.id });
          }
          for (const s of (value.statuses || [])) {
            if (s.id && s.status) {
              await db.query('UPDATE messages SET status=$1 WHERE wa_message_id=$2 AND company_id=$3', [s.status, s.id, company.id]);
            }
          }
        }
      }
    } catch (e) { console.error('[verbal] webhook processing error:', e); }
  });
});

// ===========================================================================
// PLATFORM OWNER ROUTES (/api/admin/*)
// ===========================================================================
app.get('/api/admin/plans', auth, requireSuper, (req, res) => {
  res.json({ plans: db.PLANS });
});

app.get('/api/admin/settings', auth, requireSuper, async (req, res) => {
  const s = await db.one('SELECT registration_open FROM platform_settings WHERE id=1');
  res.json({ registrationOpen: !!(s && s.registration_open), superAdminEmail: SUPER_ADMIN_EMAIL, loginUrl: clientLoginUrl(req) });
});
app.patch('/api/admin/settings', auth, requireSuper, async (req, res) => {
  const { registrationOpen } = req.body || {};
  const s = await db.one('UPDATE platform_settings SET registration_open=$1 WHERE id=1 RETURNING registration_open', [!!registrationOpen]);
  res.json({ registrationOpen: !!s.registration_open });
});

app.get('/api/admin/overview', auth, requireSuper, async (req, res) => {
  const companies = (await db.query('SELECT * FROM companies ORDER BY created_at DESC')).rows;
  const list = [];
  let totalUsers = 0; let totalContacts = 0; let active = 0; let suspended = 0; let msgs30 = 0;
  for (const c of companies) {
    const owner = await db.one(`SELECT name, email FROM users WHERE company_id=$1 AND role='owner' ORDER BY id ASC LIMIT 1`, [c.id]);
    const uc = (await db.one('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1', [c.id])).n;
    const cc = (await db.one('SELECT COUNT(*)::int AS n FROM contacts WHERE company_id=$1', [c.id])).n;
    const mc = (await db.one(`SELECT COUNT(*)::int AS n FROM messages WHERE company_id=$1 AND created_at >= (now() AT TIME ZONE 'utc') - interval '30 days'`, [c.id])).n;
    const la = await db.one('SELECT MAX(last_message_at) AS t FROM contacts WHERE company_id=$1', [c.id]);
    totalUsers += uc; totalContacts += cc; msgs30 += mc;
    if (c.status === 'active') active++; else if (c.status === 'suspended') suspended++;
    list.push({
      id: c.id, name: c.name, plan: c.plan, status: c.status,
      ownerName: owner && owner.name, ownerEmail: owner && owner.email,
      users: uc, maxUsers: c.max_users, contacts: cc, maxContacts: c.max_contacts,
      overUsers: uc > c.max_users, overContacts: cc > c.max_contacts,
      messages30d: mc, waConnected: !!(c.wa_token && c.wa_phone_id),
      lastActivity: la && la.t ? db.fmtTs(la.t) : null,
      modules: parseJSON(c.modules, []), notes: c.notes, created_at: c.created_at,
    });
  }
  res.json({
    kpis: { workspaces: companies.length, active, suspended, totalUsers, totalContacts, messages30d: msgs30 },
    companies: list,
  });
});

app.get('/api/admin/companies', auth, requireSuper, async (req, res) => {
  const companies = (await db.query('SELECT * FROM companies ORDER BY created_at DESC')).rows;
  res.json({ companies: companies.map(publicCompany) });
});

app.post('/api/admin/companies', auth, requireSuper, async (req, res) => {
  const { companyName, ownerName, ownerEmail, plan } = req.body || {};
  if (!companyName || !ownerName || !ownerEmail) return res.status(400).json({ error: 'companyName, ownerName and ownerEmail are required' });
  const planKey = db.PLANS[plan] ? plan : 'trial';
  const preset = db.PLANS[planKey];
  const existing = await db.one('SELECT id FROM users WHERE lower(email)=lower($1)', [ownerEmail]);
  if (existing) return res.status(409).json({ error: 'A user with this email already exists' });
  const company = await db.one(
    `INSERT INTO companies (name, plan, max_users, max_contacts, modules)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [companyName, planKey, preset.max_users, preset.max_contacts, JSON.stringify(preset.modules)]);
  const password = genPassword();
  const hash = await bcrypt.hash(password, 10);
  const owner = await db.one(
    `INSERT INTO users (company_id, name, email, password_hash, role, active)
     VALUES ($1,$2,$3,$4,'owner',TRUE) RETURNING *`,
    [company.id, ownerName, String(ownerEmail).toLowerCase(), hash]);
  await db.seedCompanyDefaults(company.id);
  res.status(201).json({
    company: publicCompany(company),
    credentials: { loginUrl: clientLoginUrl(req), email: owner.email, password },
  });
});

app.patch('/api/admin/companies/:id', auth, requireSuper, async (req, res) => {
  const c = await db.one('SELECT * FROM companies WHERE id=$1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'company not found' });
  const b = req.body || {}; const sets = []; const vals = []; let i = 1;

  if (b.plan !== undefined) {
    if (!db.PLANS[b.plan]) return res.status(400).json({ error: 'invalid plan' });
    const preset = db.PLANS[b.plan];
    sets.push(`plan=$${i++}`); vals.push(b.plan);
    // Reset limits/modules to preset unless explicit values supplied in same request.
    if (b.max_users === undefined) { sets.push(`max_users=$${i++}`); vals.push(preset.max_users); }
    if (b.max_contacts === undefined) { sets.push(`max_contacts=$${i++}`); vals.push(preset.max_contacts); }
    if (b.modules === undefined) { sets.push(`modules=$${i++}`); vals.push(JSON.stringify(preset.modules)); }
  }
  if (b.max_users !== undefined) { sets.push(`max_users=$${i++}`); vals.push(parseInt(b.max_users, 10)); }
  if (b.max_contacts !== undefined) { sets.push(`max_contacts=$${i++}`); vals.push(parseInt(b.max_contacts, 10)); }
  if (b.modules !== undefined) {
    const mods = (Array.isArray(b.modules) ? b.modules : []).filter((m) => db.ALL_MODULES.includes(m));
    sets.push(`modules=$${i++}`); vals.push(JSON.stringify(mods));
  }
  if (b.notes !== undefined) { sets.push(`notes=$${i++}`); vals.push(b.notes); }
  if (b.status !== undefined) {
    if (!['active', 'suspended'].includes(b.status)) return res.status(400).json({ error: 'invalid status' });
    sets.push(`status=$${i++}`); vals.push(b.status);
  }
  if (b.name !== undefined) { sets.push(`name=$${i++}`); vals.push(b.name); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(c.id);
  const up = await db.one(`UPDATE companies SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ company: publicCompany(up) });
});

app.post('/api/admin/companies/:id/reset-password', auth, requireSuper, async (req, res) => {
  const owner = await db.one(`SELECT * FROM users WHERE company_id=$1 AND role='owner' ORDER BY id ASC LIMIT 1`, [req.params.id]);
  if (!owner) return res.status(404).json({ error: 'owner not found' });
  const password = genPassword();
  const hash = await bcrypt.hash(password, 10);
  await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, owner.id]);
  res.json({ email: owner.email, password });
});

app.post('/api/admin/companies/:id/impersonate', auth, requireSuper, async (req, res) => {
  const company = await db.one('SELECT * FROM companies WHERE id=$1', [req.params.id]);
  if (!company) return res.status(404).json({ error: 'company not found' });
  const owner = await db.one(`SELECT * FROM users WHERE company_id=$1 AND role='owner' ORDER BY id ASC LIMIT 1`, [company.id]);
  if (!owner) return res.status(404).json({ error: 'owner not found' });
  const token = signToken(owner);
  res.json({ token, company: publicCompany(company), user: publicUser(owner) });
});

app.delete('/api/admin/companies/:id', auth, requireSuper, async (req, res) => {
  const c = await db.one('SELECT * FROM companies WHERE id=$1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'company not found' });
  if (c.id === req.company.id) return res.status(403).json({ error: 'You cannot delete your own workspace.' });
  const confirm = req.query.confirm;
  if (!confirm || confirm !== c.name) return res.status(400).json({ error: 'Confirmation name does not match. Type the exact workspace name to delete.' });
  await db.query('DELETE FROM companies WHERE id=$1', [c.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Static front-end (single file). Served after the setup gate.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api|webhook).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JSON 404 for unknown API routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---------------------------------------------------------------------------
if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  ensureReady().catch((e) => console.error('[verbal] schema init error:', e));
  app.listen(PORT, '0.0.0.0', () => console.log(`[verbal] listening on :${PORT} (${NODE_ENV})`));
}

module.exports = app;
