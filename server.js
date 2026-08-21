// server.js — WhatsApp CRM: multi-tenant backend (PostgreSQL)
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const wa = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_HOSTED = !!(process.env.VERCEL || process.env.NODE_ENV === 'production');

// The platform owner. This email gets the super admin dashboard.
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
const isSuperAdmin = (user) => !!SUPER_ADMIN_EMAIL && user?.email === SUPER_ADMIN_EMAIL;

/* ---------------- configuration & security gate ---------------- */
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (!IS_HOSTED) {
    // Local dev: use a random per-process secret rather than a guessable default.
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('⚠️  JWT_SECRET not set — using a temporary random secret (logins reset on restart).');
  } else {
    JWT_SECRET = null; // hosted without a real secret → blocked below
  }
}

function configProblems() {
  const p = [];
  if (!process.env.DATABASE_URL && !process.env.PGLITE_TEST) {
    p.push('DATABASE_URL is not set. Create a free Postgres database at https://neon.tech and add its connection string as an environment variable named DATABASE_URL.');
  }
  if (!JWT_SECRET) {
    p.push('JWT_SECRET is not set (or is shorter than 32 characters). Set it to a long random string — it signs login tokens, so a missing or guessable value would let anyone forge a login.');
  }
  return p;
}

const setupPage = (problems) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Setup required</title><style>
body{font-family:system-ui,sans-serif;background:#0b2b1f;color:#e8f5ef;display:flex;align-items:center;
justify-content:center;height:100vh;margin:0;padding:20px}
.c{background:#0f3a2a;border:1px solid #1d5a42;border-radius:14px;padding:30px;max-width:620px}
h1{font-size:19px;margin:0 0 6px}p{color:#a9cfbf;font-size:14px;line-height:1.6}
li{margin-bottom:12px;font-size:14px;line-height:1.6}code{background:#08251a;padding:2px 6px;border-radius:5px}
</style></head><body><div class="c"><h1>⚙️ Setup required</h1>
<p>The CRM is deployed but needs these environment variables before it can run:</p>
<ol>${problems.map((x) => `<li>${x}</li>`).join('')}</ol>
<p>Add them in your Vercel project under <b>Settings → Environment Variables</b>, then redeploy.</p>
</div></body></html>`;

app.use(express.json({ limit: '1mb' }));

// Configuration gate runs BEFORE static files, so an unconfigured deployment
// shows the setup instructions instead of a login screen that cannot work.
app.use((req, res, next) => {
  const problems = configProblems();
  if (!problems.length) return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
    return res.status(503).json({ error: 'Server not configured', problems });
  }
  res.status(503).send(setupPage(problems));
});

app.use(express.static(path.join(__dirname, 'public')));

// Create tables on first request (idempotent).
app.use(async (req, res, next) => {
  try {
    await db.ensureSchema();
    next();
  } catch (e) {
    console.error('Schema init failed:', e.message);
    res.status(503).json({ error: 'Database unavailable: ' + e.message });
  }
});

/* ---------------- helpers ---------------- */
const { row, all, run } = db;
const num = (v) => Number(v || 0);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sign(user) {
  return jwt.sign({ uid: user.id, cid: user.company_id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

const auth = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired — log in again' });
  }
  req.user = await row('SELECT * FROM users WHERE id = ? AND active = TRUE', payload.uid);
  if (!req.user) return res.status(401).json({ error: 'User not found or deactivated' });
  req.company = await row('SELECT * FROM companies WHERE id = ?', req.user.company_id);
  req.isSuper = isSuperAdmin(req.user);
  if (req.company?.status === 'suspended' && !req.isSuper) {
    return res.status(403).json({ error: 'This workspace has been suspended. Please contact support.' });
  }
  next();
});

function adminOnly(req, res, next) {
  if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Admins only' });
  next();
}

function superAdminOnly(req, res, next) {
  if (!req.isSuper) return res.status(403).json({ error: 'Platform administrators only' });
  next();
}

const companyModules = (company) => {
  try {
    const m = JSON.parse(company.modules || '[]');
    return Array.isArray(m) && m.length ? m : db.ALL_MODULES;
  } catch {
    return db.ALL_MODULES;
  }
};

// Blocks a request when the client's plan does not include the module.
const requireModule = (name) => (req, res, next) => {
  if (!companyModules(req.company).includes(name)) {
    return res.status(403).json({ error: `The ${name} module is not enabled on your plan.` });
  }
  next();
};

async function registrationOpen() {
  const s = await row('SELECT registration_open FROM platform_settings WHERE id = 1');
  return !!s?.registration_open;
}

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  active: u.active, created_at: u.created_at,
});

/* ---------------- health ---------------- */
app.get('/api/health', wrap(async (req, res) => {
  const r = await row('SELECT COUNT(*) AS n FROM companies');
  res.json({ ok: true, database: 'connected', companies: num(r.n) });
}));

/* ---------------- auth ---------------- */
// Shared by public registration and super-admin client creation.
async function createWorkspace({ companyName, name, email, password, industry = '', country = '', plan = 'trial' }) {
  const preset = db.PLANS[plan] || db.PLANS.trial;
  const company = await run(
    `INSERT INTO companies (name, industry, country, plan, max_users, max_contacts, modules)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
    companyName, industry, country, plan, preset.max_users, preset.max_contacts, JSON.stringify(preset.modules));
  const hash = await bcrypt.hash(password, 10);
  const created = await run(
    'INSERT INTO users (company_id, name, email, password_hash, role) VALUES (?,?,?,?,?) RETURNING id',
    company.id, name, email, hash, 'owner');
  await run('INSERT INTO bot_rules (company_id, name, trigger_type, reply) VALUES (?,?,?,?)',
    company.id, 'Welcome message', 'welcome',
    `Hi! 👋 Thanks for contacting ${companyName}. An agent will be with you shortly.`);
  return { companyId: company.id, user: await row('SELECT * FROM users WHERE id = ?', created.id) };
}

// Register = create a new company workspace + its owner account
app.post('/api/auth/register', wrap(async (req, res) => {
  const { companyName, name, email, password, industry = '', country = '' } = req.body || {};
  if (!companyName || !name || !email || !password) return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const mail = String(email).toLowerCase().trim();

  // Self-service signup is normally closed. Always allow the very first account
  // and the designated platform owner, so the system can be bootstrapped.
  const firstEver = !(await row('SELECT id FROM users LIMIT 1'));
  const allowed = firstEver || mail === SUPER_ADMIN_EMAIL || (await registrationOpen());
  if (!allowed) {
    return res.status(403).json({ error: 'Public sign-up is closed. Please contact us to have an account created for you.' });
  }

  if (await row('SELECT id FROM users WHERE email = ?', mail)) return res.status(409).json({ error: 'Email already registered' });

  const { user } = await createWorkspace({ companyName, name, email: mail, password, industry, country });
  res.json({ token: sign(user), user: publicUser(user) });
}));

// Lets the login screen hide the sign-up tab when registration is closed.
app.get('/api/auth/config', wrap(async (req, res) => {
  const firstEver = !(await row('SELECT id FROM users LIMIT 1'));
  res.json({ registrationOpen: firstEver || (await registrationOpen()), firstRun: firstEver });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await row('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase().trim());
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'Account deactivated — contact your admin' });
  res.json({ token: sign(user), user: publicUser(user) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const [uc, cc] = await Promise.all([
    row('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = TRUE', req.company.id),
    row('SELECT COUNT(*) AS n FROM contacts WHERE company_id = ?', req.company.id),
  ]);
  res.json({
    user: publicUser(req.user),
    isSuperAdmin: req.isSuper,
    company: {
      id: req.company.id, name: req.company.name, industry: req.company.industry,
      country: req.company.country, logo_emoji: req.company.logo_emoji,
      plan: req.company.plan, status: req.company.status,
      modules: companyModules(req.company),
      max_users: req.company.max_users, max_contacts: req.company.max_contacts,
      used_users: num(uc.n), used_contacts: num(cc.n),
      wa_configured: wa.isConfigured(req.company),
      wa_phone_id: req.company.wa_phone_id,
      wa_verify_token: req.company.wa_verify_token,
      wa_token_set: !!req.company.wa_token,
    },
  });
}));

/* ---------------- team / users ---------------- */
app.get('/api/users', auth, wrap(async (req, res) => {
  const users = await all('SELECT * FROM users WHERE company_id = ? ORDER BY created_at, id', req.user.company_id);
  res.json(users.map(publicUser));
}));

app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const { name, email, password, role = 'agent' } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['admin', 'agent'].includes(role)) return res.status(400).json({ error: 'Role must be admin or agent' });
  const mail = String(email).toLowerCase().trim();
  if (await row('SELECT id FROM users WHERE email = ?', mail)) return res.status(409).json({ error: 'Email already registered' });

  const used = num((await row('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = TRUE', req.user.company_id)).n);
  if (used >= req.company.max_users) {
    return res.status(402).json({
      error: `Your plan allows ${req.company.max_users} active users and you are using ${used}. Upgrade your plan or deactivate a user to add another.`,
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const created = await run(
    'INSERT INTO users (company_id, name, email, password_hash, role) VALUES (?,?,?,?,?) RETURNING id',
    req.user.company_id, name, mail, hash, role);
  res.json(publicUser(await row('SELECT * FROM users WHERE id = ?', created.id)));
}));

app.patch('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const target = await row('SELECT * FROM users WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'The owner account cannot be modified here' });
  const { role, active } = req.body || {};
  if (role && ['admin', 'agent'].includes(role)) await run('UPDATE users SET role = ? WHERE id = ?', role, target.id);
  if (active !== undefined) await run('UPDATE users SET active = ? WHERE id = ?', !!active, target.id);
  res.json(publicUser(await row('SELECT * FROM users WHERE id = ?', target.id)));
}));

app.delete('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const target = await row('SELECT * FROM users WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'The owner account cannot be removed' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  await run('UPDATE contacts SET owner_user_id = NULL WHERE owner_user_id = ?', target.id);
  await run('DELETE FROM users WHERE id = ?', target.id);
  res.json({ ok: true });
}));

/* ---------------- company settings ---------------- */
app.patch('/api/company', auth, adminOnly, wrap(async (req, res) => {
  const { name, industry, country, logo_emoji, wa_token, wa_phone_id, wa_verify_token } = req.body || {};
  const c = req.company;
  await run(
    `UPDATE companies SET name=?, industry=?, country=?, logo_emoji=?, wa_token=?, wa_phone_id=?, wa_verify_token=? WHERE id=?`,
    name ?? c.name, industry ?? c.industry, country ?? c.country, logo_emoji ?? c.logo_emoji,
    wa_token !== undefined ? wa_token : c.wa_token,
    wa_phone_id !== undefined ? wa_phone_id : c.wa_phone_id,
    wa_verify_token !== undefined ? wa_verify_token : c.wa_verify_token,
    c.id);
  res.json({ ok: true });
}));

/* ---------------- contacts ---------------- */
app.get('/api/contacts', auth, wrap(async (req, res) => {
  const list = await all(
    'SELECT * FROM contacts WHERE company_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC',
    req.user.company_id);
  res.json(list.map((c) => ({ ...c, tags: JSON.parse(c.tags || '[]') })));
}));

app.post('/api/contacts', auth, wrap(async (req, res) => {
  const { name, phone, company = '', stage = 'New Lead', tags = [], source = 'Manual' } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });

  const used = num((await row('SELECT COUNT(*) AS n FROM contacts WHERE company_id = ?', req.user.company_id)).n);
  if (used >= req.company.max_contacts) {
    return res.status(402).json({
      error: `Your plan allows ${req.company.max_contacts.toLocaleString()} contacts and you have ${used.toLocaleString()}. Upgrade your plan to add more.`,
    });
  }

  const created = await run(
    'INSERT INTO contacts (company_id, name, phone, company, stage, tags, source) VALUES (?,?,?,?,?,?,?) RETURNING id',
    req.user.company_id, name, phone, company, stage, JSON.stringify(tags), source);
  res.json(await row('SELECT * FROM contacts WHERE id = ?', created.id));
}));

app.patch('/api/contacts/:id', auth, wrap(async (req, res) => {
  const c = await row('SELECT * FROM contacts WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  const { name, phone, company, stage, tags, owner_user_id, unread } = req.body || {};
  await run(
    `UPDATE contacts SET name=?, phone=?, company=?, stage=?, tags=?, owner_user_id=?, unread=? WHERE id=?`,
    name ?? c.name, phone ?? c.phone, company ?? c.company, stage ?? c.stage,
    tags !== undefined ? JSON.stringify(tags) : c.tags,
    owner_user_id !== undefined ? owner_user_id : c.owner_user_id,
    unread !== undefined ? unread : c.unread, c.id);
  res.json({ ok: true });
}));

app.delete('/api/contacts/:id', auth, wrap(async (req, res) => {
  await run('DELETE FROM messages WHERE contact_id = ? AND company_id = ?', req.params.id, req.user.company_id);
  await run('DELETE FROM contacts WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

/* ---------------- messages / inbox ---------------- */
app.get('/api/messages/:contactId', auth, wrap(async (req, res) => {
  const c = await row('SELECT * FROM contacts WHERE id = ? AND company_id = ?', req.params.contactId, req.user.company_id);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  await run('UPDATE contacts SET unread = 0 WHERE id = ?', c.id);
  res.json(await all(
    `SELECT m.*, u.name AS sender_name FROM messages m
     LEFT JOIN users u ON u.id = m.sent_by_user_id
     WHERE m.contact_id = ? ORDER BY m.id`, c.id));
}));

app.post('/api/messages/:contactId', auth, wrap(async (req, res) => {
  const c = await row('SELECT * FROM contacts WHERE id = ? AND company_id = ?', req.params.contactId, req.user.company_id);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  const { body, direction = 'out' } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Message body required' });

  if (direction === 'note') {
    await run(
      'INSERT INTO messages (company_id, contact_id, direction, body, sent_by_user_id, status) VALUES (?,?,?,?,?,?)',
      req.user.company_id, c.id, 'note', body, req.user.id, 'sent');
    return res.json({ ok: true, demo: false });
  }

  let result;
  try {
    result = await wa.sendText(req.company, c.phone, body);
  } catch (e) {
    await run(
      'INSERT INTO messages (company_id, contact_id, direction, body, sent_by_user_id, status) VALUES (?,?,?,?,?,?)',
      req.user.company_id, c.id, 'out', body, req.user.id, 'failed');
    return res.status(502).json({ error: 'WhatsApp send failed: ' + e.message });
  }
  await run(
    'INSERT INTO messages (company_id, contact_id, direction, body, sent_by_user_id, wa_message_id, status) VALUES (?,?,?,?,?,?,?)',
    req.user.company_id, c.id, 'out', body, req.user.id, result.id, result.demo ? 'demo' : 'sent');
  await run(`UPDATE contacts SET last_message_at = (NOW() AT TIME ZONE 'utc') WHERE id = ?`, c.id);
  res.json({ ok: true, demo: result.demo });
}));

/* ---------------- templates ---------------- */
app.get('/api/templates', auth, requireModule('templates'), wrap(async (req, res) => {
  res.json(await all('SELECT * FROM templates WHERE company_id = ? ORDER BY created_at DESC, id DESC', req.user.company_id));
}));

app.post('/api/templates', auth, requireModule('templates'), wrap(async (req, res) => {
  const { name, category = 'Utility', body, status = 'Pending Review' } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'Name and body required' });
  const created = await run(
    'INSERT INTO templates (company_id, name, category, body, status) VALUES (?,?,?,?,?) RETURNING id',
    req.user.company_id, name.toLowerCase().replace(/\s+/g, '_'), category, body, status);
  res.json(await row('SELECT * FROM templates WHERE id = ?', created.id));
}));

app.patch('/api/templates/:id', auth, wrap(async (req, res) => {
  const t = await row('SELECT * FROM templates WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const { status, body } = req.body || {};
  await run('UPDATE templates SET status = ?, body = ? WHERE id = ?', status ?? t.status, body ?? t.body, t.id);
  res.json({ ok: true });
}));

app.delete('/api/templates/:id', auth, wrap(async (req, res) => {
  await run('DELETE FROM templates WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

/* ---------------- campaigns ---------------- */
async function segmentContacts(companyId, segment) {
  const contacts = (await all('SELECT * FROM contacts WHERE company_id = ?', companyId))
    .map((c) => ({ ...c, tags: JSON.parse(c.tags || '[]') }));
  if (segment.startsWith('Tag: ')) return contacts.filter((c) => c.tags.includes(segment.slice(5)));
  if (segment.startsWith('Stage: ')) return contacts.filter((c) => c.stage === segment.slice(7));
  return contacts;
}

app.get('/api/campaigns', auth, requireModule('broadcast'), wrap(async (req, res) => {
  res.json(await all(
    `SELECT cp.*, t.name AS template_name FROM campaigns cp
     LEFT JOIN templates t ON t.id = cp.template_id
     WHERE cp.company_id = ? ORDER BY cp.created_at DESC, cp.id DESC`, req.user.company_id));
}));

app.post('/api/campaigns', auth, adminOnly, requireModule('broadcast'), wrap(async (req, res) => {
  const { name, template_id, segment = 'All Contacts' } = req.body || {};
  if (!name || !template_id) return res.status(400).json({ error: 'Name and template required' });
  const tpl = await row('SELECT * FROM templates WHERE id = ? AND company_id = ?', template_id, req.user.company_id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const targets = await segmentContacts(req.user.company_id, segment);
  if (!targets.length) return res.status(400).json({ error: 'Segment has no contacts' });

  const camp = await run(
    'INSERT INTO campaigns (company_id, name, template_id, segment, audience, status) VALUES (?,?,?,?,?,?) RETURNING id',
    req.user.company_id, name, template_id, segment, targets.length, 'Sending');

  let sent = 0, delivered = 0, failed = 0;
  for (const c of targets) {
    try {
      const result = await wa.sendTemplate(req.company, c.phone, tpl.name);
      sent++; delivered++;
      await run(
        'INSERT INTO messages (company_id, contact_id, direction, body, sent_by_user_id, wa_message_id, status) VALUES (?,?,?,?,?,?,?)',
        req.user.company_id, c.id, 'out', `[Campaign: ${name}] ` + tpl.body, req.user.id, result.id,
        result.demo ? 'demo' : 'sent');
    } catch {
      sent++; failed++;
    }
  }
  await run('UPDATE campaigns SET sent=?, delivered=?, failed=?, status=? WHERE id=?',
    sent, delivered, failed, 'Completed', camp.id);
  res.json({ ok: true, sent, delivered, failed, demo: !wa.isConfigured(req.company) });
}));

/* ---------------- bots ---------------- */
app.get('/api/bots', auth, requireModule('automation'), wrap(async (req, res) => {
  res.json(await all('SELECT * FROM bot_rules WHERE company_id = ? ORDER BY created_at, id', req.user.company_id));
}));

app.post('/api/bots', auth, adminOnly, requireModule('automation'), wrap(async (req, res) => {
  const { name, trigger_type, keyword = '', reply } = req.body || {};
  if (!name || !trigger_type || !reply) return res.status(400).json({ error: 'Name, trigger and reply required' });
  const created = await run(
    'INSERT INTO bot_rules (company_id, name, trigger_type, keyword, reply) VALUES (?,?,?,?,?) RETURNING id',
    req.user.company_id, name, trigger_type, keyword.toLowerCase(), reply);
  res.json(await row('SELECT * FROM bot_rules WHERE id = ?', created.id));
}));

app.patch('/api/bots/:id', auth, adminOnly, wrap(async (req, res) => {
  const b = await row('SELECT * FROM bot_rules WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  if (!b) return res.status(404).json({ error: 'Rule not found' });
  const { active, reply, keyword, name } = req.body || {};
  await run('UPDATE bot_rules SET active=?, reply=?, keyword=?, name=? WHERE id=?',
    active !== undefined ? !!active : b.active, reply ?? b.reply, keyword ?? b.keyword, name ?? b.name, b.id);
  res.json({ ok: true });
}));

app.delete('/api/bots/:id', auth, adminOnly, wrap(async (req, res) => {
  await run('DELETE FROM bot_rules WHERE id = ? AND company_id = ?', req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

/* ---------------- bot engine (shared by webhook + simulator) ---------------- */
async function runBots(company, contact, text, isNewContact, { send }) {
  const rules = await all('SELECT * FROM bot_rules WHERE company_id = ? AND active = TRUE ORDER BY id', company.id);
  let matched = isNewContact ? rules.find((r) => r.trigger_type === 'welcome') : null;
  if (!matched) {
    matched = rules.find((r) => r.trigger_type === 'keyword' && r.keyword && text.toLowerCase().includes(r.keyword));
  }
  if (!matched) return null;

  let waId = null, status = 'demo';
  if (send) {
    try {
      const r = await wa.sendText(company, contact.phone, matched.reply);
      waId = r.id;
      status = r.demo ? 'demo' : 'sent';
    } catch (e) {
      console.error('Bot reply failed:', e.message);
      status = 'failed';
    }
  }
  await run(
    'INSERT INTO messages (company_id, contact_id, direction, body, wa_message_id, status) VALUES (?,?,?,?,?,?)',
    company.id, contact.id, 'out', '🤖 ' + matched.reply, waId, status);
  await run('UPDATE bot_rules SET runs = runs + 1 WHERE id = ?', matched.id);
  return matched;
}

/* ---------------- WhatsApp webhook (per company) ---------------- */
// Meta callback URL: https://YOUR-DOMAIN/webhook/<companyId>
app.get('/webhook/:companyId', wrap(async (req, res) => {
  const company = await row('SELECT * FROM companies WHERE id = ?', req.params.companyId);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (company && mode === 'subscribe' && company.wa_verify_token && token === company.wa_verify_token) {
    return res.send(challenge);
  }
  res.sendStatus(403);
}));

app.post('/webhook/:companyId', (req, res) => {
  res.sendStatus(200); // acknowledge immediately, then process
  handleWebhook(req.params.companyId, req.body).catch((e) => console.error('Webhook error:', e.message));
});

async function handleWebhook(companyId, payload) {
  const company = await row('SELECT * FROM companies WHERE id = ?', companyId);
  if (!company) return;
  const entry = payload?.entry?.[0]?.changes?.[0]?.value;

  for (const st of entry?.statuses || []) {
    await run('UPDATE messages SET status = ? WHERE wa_message_id = ?', st.status, st.id);
  }

  for (const msg of entry?.messages || []) {
    const from = '+' + msg.from;
    const text = msg.text?.body || `[${msg.type} message]`;
    let contact = await row(
      `SELECT * FROM contacts WHERE company_id = ? AND replace(replace(phone,' ',''),'-','') = ?`,
      company.id, from.replace(/[\s-]/g, ''));
    let isNew = false;
    if (!contact) {
      const profileName = entry?.contacts?.[0]?.profile?.name || from;
      const created = await run(
        'INSERT INTO contacts (company_id, name, phone, source, tags) VALUES (?,?,?,?,?) RETURNING id',
        company.id, profileName, from, 'WhatsApp Inbound', JSON.stringify(['New']));
      contact = await row('SELECT * FROM contacts WHERE id = ?', created.id);
      isNew = true;
    }
    await run('INSERT INTO messages (company_id, contact_id, direction, body, wa_message_id) VALUES (?,?,?,?,?)',
      company.id, contact.id, 'in', text, msg.id);
    await run(`UPDATE contacts SET unread = unread + 1, last_message_at = (NOW() AT TIME ZONE 'utc') WHERE id = ?`, contact.id);
    await runBots(company, contact, text, isNew, { send: true });
  }
}

/* ---------------- simulator (test without Meta credentials) ---------------- */
app.post('/api/simulate-incoming', auth, wrap(async (req, res) => {
  const { contactId, phone, name, body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Message body required' });
  let contact = contactId
    ? await row('SELECT * FROM contacts WHERE id = ? AND company_id = ?', contactId, req.user.company_id)
    : null;
  let isNew = false;
  if (!contact) {
    if (!phone) return res.status(400).json({ error: 'Pick a contact or enter a phone number' });
    const created = await run(
      'INSERT INTO contacts (company_id, name, phone, source, tags) VALUES (?,?,?,?,?) RETURNING id',
      req.user.company_id, name || phone, phone, 'WhatsApp Inbound', JSON.stringify(['New']));
    contact = await row('SELECT * FROM contacts WHERE id = ?', created.id);
    isNew = true;
  }
  await run('INSERT INTO messages (company_id, contact_id, direction, body) VALUES (?,?,?,?)',
    req.user.company_id, contact.id, 'in', body);
  await run(`UPDATE contacts SET unread = unread + 1, last_message_at = (NOW() AT TIME ZONE 'utc') WHERE id = ?`, contact.id);
  const matched = await runBots(req.company, contact, body, isNew, { send: false });
  res.json({ ok: true, botReplied: !!matched });
}));

/* ---------------- dashboard stats ---------------- */
app.get('/api/stats', auth, wrap(async (req, res) => {
  const cid = req.user.company_id;
  const [contacts, unread, msgs, camps, users, stages, bots] = await Promise.all([
    row('SELECT COUNT(*) AS n FROM contacts WHERE company_id = ?', cid),
    row('SELECT COALESCE(SUM(unread),0) AS n FROM contacts WHERE company_id = ?', cid),
    row(`SELECT COUNT(*) AS n FROM messages WHERE company_id = ? AND created_at > (NOW() AT TIME ZONE 'utc') - INTERVAL '7 days'`, cid),
    row('SELECT COUNT(*) AS n FROM campaigns WHERE company_id = ?', cid),
    row('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = TRUE', cid),
    all('SELECT stage, COUNT(*) AS n FROM contacts WHERE company_id = ? GROUP BY stage', cid),
    row('SELECT COALESCE(SUM(runs),0) AS n FROM bot_rules WHERE company_id = ?', cid),
  ]);
  res.json({
    contacts: num(contacts.n),
    unread: num(unread.n),
    messages7d: num(msgs.n),
    campaigns: num(camps.n),
    users: num(users.n),
    stages: stages.map((s) => ({ stage: s.stage, n: num(s.n) })),
    botRuns: num(bots.n),
  });
}));

/* ================================================================
   SUPER ADMIN — platform owner only (set SUPER_ADMIN_EMAIL)
   ================================================================ */

app.get('/api/admin/plans', auth, superAdminOnly, (req, res) => {
  res.json({ plans: db.PLANS, modules: db.ALL_MODULES });
});

app.get('/api/admin/settings', auth, superAdminOnly, wrap(async (req, res) => {
  res.json({ registrationOpen: await registrationOpen(), superAdminEmail: SUPER_ADMIN_EMAIL });
}));

app.patch('/api/admin/settings', auth, superAdminOnly, wrap(async (req, res) => {
  const { registrationOpen: open } = req.body || {};
  await run('UPDATE platform_settings SET registration_open = ? WHERE id = 1', !!open);
  res.json({ ok: true });
}));

// Platform-wide totals
app.get('/api/admin/overview', auth, superAdminOnly, wrap(async (req, res) => {
  const [companies, active, suspended, users, contacts, messages, msgs30] = await Promise.all([
    row('SELECT COUNT(*) AS n FROM companies'),
    row(`SELECT COUNT(*) AS n FROM companies WHERE status = 'active'`),
    row(`SELECT COUNT(*) AS n FROM companies WHERE status = 'suspended'`),
    row('SELECT COUNT(*) AS n FROM users'),
    row('SELECT COUNT(*) AS n FROM contacts'),
    row('SELECT COUNT(*) AS n FROM messages'),
    row(`SELECT COUNT(*) AS n FROM messages WHERE created_at > (NOW() AT TIME ZONE 'utc') - INTERVAL '30 days'`),
  ]);
  res.json({
    companies: num(companies.n), active: num(active.n), suspended: num(suspended.n),
    users: num(users.n), contacts: num(contacts.n),
    messages: num(messages.n), messages30d: num(msgs30.n),
  });
}));

// All client workspaces with usage
app.get('/api/admin/companies', auth, superAdminOnly, wrap(async (req, res) => {
  const rows = await all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = TRUE) AS user_count,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) AS contact_count,
      (SELECT COUNT(*) FROM messages m WHERE m.company_id = c.id) AS message_count,
      (SELECT COUNT(*) FROM messages m WHERE m.company_id = c.id
        AND m.created_at > (NOW() AT TIME ZONE 'utc') - INTERVAL '30 days') AS messages_30d,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.company_id = c.id) AS last_activity,
      (SELECT u.email FROM users u WHERE u.company_id = c.id AND u.role = 'owner' LIMIT 1) AS owner_email,
      (SELECT u.name FROM users u WHERE u.company_id = c.id AND u.role = 'owner' LIMIT 1) AS owner_name
    FROM companies c ORDER BY c.created_at DESC, c.id DESC`);
  res.json(rows.map((c) => ({
    id: c.id, name: c.name, industry: c.industry, country: c.country, logo_emoji: c.logo_emoji,
    status: c.status, plan: c.plan, notes: c.notes,
    max_users: c.max_users, max_contacts: c.max_contacts, modules: companyModules(c),
    wa_configured: wa.isConfigured(c),
    owner_email: c.owner_email, owner_name: c.owner_name,
    users: num(c.user_count), contacts: num(c.contact_count),
    messages: num(c.message_count), messages_30d: num(c.messages_30d),
    last_activity: c.last_activity, created_at: c.created_at,
  })));
}));

// Create a client workspace and its owner login
app.post('/api/admin/companies', auth, superAdminOnly, wrap(async (req, res) => {
  const { companyName, ownerName, email, password, plan = 'trial', country = '', industry = '' } = req.body || {};
  if (!companyName || !ownerName || !email || !password) {
    return res.status(400).json({ error: 'Company, owner name, email and password are required' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!db.PLANS[plan]) return res.status(400).json({ error: 'Unknown plan' });
  const mail = String(email).toLowerCase().trim();
  if (await row('SELECT id FROM users WHERE email = ?', mail)) return res.status(409).json({ error: 'Email already registered' });

  const { companyId } = await createWorkspace({
    companyName, name: ownerName, email: mail, password, industry, country, plan,
  });
  res.json({ ok: true, companyId, loginEmail: mail });
}));

// Update status / plan / limits / modules / notes
app.patch('/api/admin/companies/:id', auth, superAdminOnly, wrap(async (req, res) => {
  const c = await row('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const { status, plan, max_users, max_contacts, modules, name, notes } = req.body || {};

  if (status && !['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (plan && !db.PLANS[plan]) return res.status(400).json({ error: 'Unknown plan' });
  if (modules && (!Array.isArray(modules) || modules.some((m) => !db.ALL_MODULES.includes(m)))) {
    return res.status(400).json({ error: 'Invalid module list' });
  }

  // Changing plan applies that plan's presets unless explicit values are given.
  const preset = plan && plan !== c.plan ? db.PLANS[plan] : null;
  await run(
    `UPDATE companies SET status=?, plan=?, max_users=?, max_contacts=?, modules=?, name=?, notes=? WHERE id=?`,
    status ?? c.status,
    plan ?? c.plan,
    max_users ?? preset?.max_users ?? c.max_users,
    max_contacts ?? preset?.max_contacts ?? c.max_contacts,
    modules ? JSON.stringify(modules) : (preset ? JSON.stringify(preset.modules) : c.modules),
    name ?? c.name,
    notes ?? c.notes,
    c.id);
  res.json({ ok: true });
}));

// Reset a client owner's password (support recovery)
app.post('/api/admin/companies/:id/reset-password', auth, superAdminOnly, wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const owner = await row(`SELECT * FROM users WHERE company_id = ? AND role = 'owner' LIMIT 1`, req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner account not found' });
  await run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(password, 10), owner.id);
  res.json({ ok: true, email: owner.email });
}));

// Open a client's workspace as their owner (support / demo)
app.post('/api/admin/companies/:id/impersonate', auth, superAdminOnly, wrap(async (req, res) => {
  const owner = await row(`SELECT * FROM users WHERE company_id = ? AND role = 'owner' AND active = TRUE LIMIT 1`, req.params.id);
  if (!owner) return res.status(404).json({ error: 'No active owner for this client' });
  const company = await row('SELECT * FROM companies WHERE id = ?', req.params.id);
  res.json({ token: sign(owner), companyName: company.name });
}));

// Permanently delete a client and all of its data
app.delete('/api/admin/companies/:id', auth, superAdminOnly, wrap(async (req, res) => {
  const c = await row('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Client not found' });
  if (Number(c.id) === Number(req.user.company_id)) {
    return res.status(400).json({ error: 'You cannot delete your own workspace' });
  }
  if (String(req.query.confirm || '') !== c.name) {
    return res.status(400).json({ error: 'Type the client name exactly to confirm deletion' });
  }
  // Children first (works even where ON DELETE CASCADE was not applied).
  await run('DELETE FROM messages WHERE company_id = ?', c.id);
  await run('DELETE FROM contacts WHERE company_id = ?', c.id);
  await run('DELETE FROM campaigns WHERE company_id = ?', c.id);
  await run('DELETE FROM templates WHERE company_id = ?', c.id);
  await run('DELETE FROM bot_rules WHERE company_id = ?', c.id);
  await run('DELETE FROM users WHERE company_id = ?', c.id);
  await run('DELETE FROM companies WHERE id = ?', c.id);
  res.json({ ok: true });
}));

/* ---------------- errors ---------------- */
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`✅ WhatsApp CRM running → http://localhost:${PORT}`));
}
module.exports = app; // for serverless platforms (Vercel)
