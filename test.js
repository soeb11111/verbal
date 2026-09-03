// test.js — API suite. Runs the Express app in-process against PGlite
// (PostgreSQL in WASM) so no external database is required.
//
//   npm test
//
// Uses a tiny custom harness (no external test deps) and Node's global fetch.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_key_that_is_definitely_over_32_chars_long';
process.env.SUPER_ADMIN_EMAIL = 'super@test.com';

const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  \u2713', name); }
  catch (e) { failed++; failures.push([name, e]); console.log('  \u2717', name, '\n     ' + (e && e.message)); }
}

let BASE = '';
async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = { _raw: text }; }
  return { status: res.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const db = require('./db');
  db.useAdapter({ query: (t, p) => pg.query(t, p) });
  await db.ensureSchema();

  const app = require('./server');
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  BASE = 'http://127.0.0.1:' + server.address().port;

  // ---- Auth & bootstrap ---------------------------------------------------
  await test('health returns ok with database up', async () => {
    const r = await api('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });

  await test('auth/config reports firstRun on empty database', async () => {
    const r = await api('GET', '/api/auth/config');
    assert.strictEqual(r.body.firstRun, true);
    assert.strictEqual(r.body.registrationOpen, false);
  });

  let superToken = '';
  await test('first-run registration creates the platform owner', async () => {
    const r = await api('POST', '/api/auth/register', { body: { companyName: 'HQ', name: 'Boss', email: 'super@test.com', password: 'secret123' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.isSuperAdmin, true);
    superToken = r.body.token;
  });

  await test('public registration is closed after first run', async () => {
    const r = await api('POST', '/api/auth/register', { body: { companyName: 'X', name: 'x', email: 'x@x.com', password: 'secret123' } });
    assert.strictEqual(r.status, 403);
  });

  await test('platform owner can open and close public sign-up', async () => {
    let r = await api('PATCH', '/api/admin/settings', { token: superToken, body: { registrationOpen: true } });
    assert.strictEqual(r.body.registrationOpen, true);
    r = await api('POST', '/api/auth/register', { body: { companyName: 'Open Co', name: 'o', email: 'open@x.com', password: 'secret123' } });
    assert.strictEqual(r.status, 201);
    r = await api('PATCH', '/api/admin/settings', { token: superToken, body: { registrationOpen: false } });
    assert.strictEqual(r.body.registrationOpen, false);
    r = await api('POST', '/api/auth/register', { body: { companyName: 'Y', name: 'y', email: 'y@x.com', password: 'secret123' } });
    assert.strictEqual(r.status, 403);
  });

  await test('login rejects wrong password and forged tokens', async () => {
    let r = await api('POST', '/api/auth/login', { body: { email: 'super@test.com', password: 'wrong' } });
    assert.strictEqual(r.status, 401);
    r = await api('GET', '/api/me', { token: 'not.a.valid.token' });
    assert.strictEqual(r.status, 401);
    r = await api('GET', '/api/me', {});
    assert.strictEqual(r.status, 401);
  });

  // ---- Platform owner creates client workspaces ---------------------------
  let compA, compB, ownerAToken, ownerBToken;
  await test('platform owner creates two client workspaces with credentials', async () => {
    let r = await api('POST', '/api/admin/companies', { token: superToken, body: { companyName: 'Alpha', ownerName: 'Alice', ownerEmail: 'alice@alpha.com', plan: 'pro' } });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.credentials.password);
    compA = r.body.company;
    const la = await api('POST', '/api/auth/login', { body: { email: 'alice@alpha.com', password: r.body.credentials.password } });
    ownerAToken = la.body.token;

    r = await api('POST', '/api/admin/companies', { token: superToken, body: { companyName: 'Beta', ownerName: 'Bob', ownerEmail: 'bob@beta.com', plan: 'pro' } });
    compB = r.body.company;
    const lb = await api('POST', '/api/auth/login', { body: { email: 'bob@beta.com', password: r.body.credentials.password } });
    ownerBToken = lb.body.token;
  });

  // ---- Tenant isolation ---------------------------------------------------
  let contactA;
  await test('tenant isolation: company B cannot read/modify company A data', async () => {
    let r = await api('POST', '/api/contacts', { token: ownerAToken, body: { name: 'Customer A', phone: '+15550001' } });
    assert.strictEqual(r.status, 201);
    contactA = r.body.contact;
    // B lists contacts -> must not include A's
    r = await api('GET', '/api/contacts', { token: ownerBToken });
    assert.strictEqual(r.body.contacts.length, 0);
    // B reads A's messages -> 404
    r = await api('GET', '/api/messages/' + contactA.id, { token: ownerBToken });
    assert.strictEqual(r.status, 404);
    // B patches A's contact -> 404
    r = await api('PATCH', '/api/contacts/' + contactA.id, { token: ownerBToken, body: { name: 'hacked' } });
    assert.strictEqual(r.status, 404);
    // B deletes A's contact -> 404
    r = await api('DELETE', '/api/contacts/' + contactA.id, { token: ownerBToken });
    assert.strictEqual(r.status, 404);
  });

  // ---- Roles --------------------------------------------------------------
  let agentToken;
  await test('agent role is restricted from admin actions', async () => {
    let r = await api('POST', '/api/users', { token: ownerAToken, body: { name: 'Aggie', email: 'aggie@alpha.com', password: 'secret123', role: 'agent' } });
    assert.strictEqual(r.status, 201);
    const la = await api('POST', '/api/auth/login', { body: { email: 'aggie@alpha.com', password: 'secret123' } });
    agentToken = la.body.token;
    // agent can list contacts
    r = await api('GET', '/api/contacts', { token: agentToken });
    assert.strictEqual(r.status, 200);
    // agent cannot create users
    r = await api('POST', '/api/users', { token: agentToken, body: { name: 'z', email: 'z@alpha.com', password: 'secret123', role: 'agent' } });
    assert.strictEqual(r.status, 403);
    // agent cannot edit company settings
    r = await api('PATCH', '/api/company', { token: agentToken, body: { name: 'New' } });
    assert.strictEqual(r.status, 403);
    // agent cannot launch campaigns
    r = await api('POST', '/api/campaigns', { token: agentToken, body: { name: 'c', template_id: 1 } });
    assert.strictEqual(r.status, 403);
  });

  // ---- Plan limits (402 at boundary) --------------------------------------
  await test('user limit returns 402 at the boundary', async () => {
    // Alpha now has owner + 1 agent = 2 users. Set max_users to 2.
    await api('PATCH', '/api/admin/companies/' + compA.id, { token: superToken, body: { max_users: 2 } });
    const r = await api('POST', '/api/users', { token: ownerAToken, body: { name: 'Over', email: 'over@alpha.com', password: 'secret123', role: 'agent' } });
    assert.strictEqual(r.status, 402);
  });

  await test('contact limit returns 402 at the boundary', async () => {
    // Alpha has 1 contact already. Set max_contacts to 1 -> next create fails.
    await api('PATCH', '/api/admin/companies/' + compA.id, { token: superToken, body: { max_contacts: 1 } });
    const r = await api('POST', '/api/contacts', { token: ownerAToken, body: { name: 'Extra', phone: '+15550002' } });
    assert.strictEqual(r.status, 402);
    // restore for later tests
    await api('PATCH', '/api/admin/companies/' + compA.id, { token: superToken, body: { max_contacts: 25000 } });
  });

  // ---- Module gating ------------------------------------------------------
  await test('disabled module returns 403 from its API', async () => {
    await api('PATCH', '/api/admin/companies/' + compB.id, { token: superToken, body: { modules: ['inbox', 'contacts', 'templates'] } });
    const r = await api('GET', '/api/bots', { token: ownerBToken });
    assert.strictEqual(r.status, 403);
    const r2 = await api('GET', '/api/templates', { token: ownerBToken });
    assert.strictEqual(r2.status, 200);
    // restore
    await api('PATCH', '/api/admin/companies/' + compB.id, { token: superToken, body: { modules: ['inbox', 'contacts', 'broadcast', 'templates', 'automation'] } });
  });

  // ---- Inbox filters: awaiting reply --------------------------------------
  await test('awaiting reply appears on inbound and clears on outbound', async () => {
    let r = await api('POST', '/api/simulate-incoming', { token: ownerAToken, body: { phone: '+15559999', name: 'Wilma', body: 'hello there' } });
    assert.strictEqual(r.status, 201);
    const cid = r.body.contact.id;
    let counts = await api('GET', '/api/inbox/counts', { token: ownerAToken });
    assert.ok(counts.body.awaiting >= 1);
    let list = await api('GET', '/api/contacts?view=awaiting', { token: ownerAToken });
    assert.ok(list.body.contacts.some((c) => c.id === cid));
    // owner replies -> awaiting clears for this contact
    await api('POST', '/api/messages/' + cid, { token: ownerAToken, body: { body: 'Hi Wilma!' } });
    list = await api('GET', '/api/contacts?view=awaiting', { token: ownerAToken });
    assert.ok(!list.body.contacts.some((c) => c.id === cid));
  });

  // ---- Resolve / reopen / auto-reopen -------------------------------------
  await test('resolve closes with audit note; inbound auto-reopens', async () => {
    let r = await api('POST', '/api/simulate-incoming', { token: ownerAToken, body: { phone: '+15558888', name: 'Rob', body: 'question' } });
    const cid = r.body.contact.id;
    r = await api('POST', '/api/contacts/' + cid + '/status', { token: ownerAToken, body: { status: 'closed' } });
    assert.strictEqual(r.body.contact.status, 'closed');
    const msgs = await api('GET', '/api/messages/' + cid, { token: ownerAToken });
    assert.ok(msgs.body.messages.some((m) => m.direction === 'note' && /resolved/i.test(m.body)));
    // inbound reopens
    r = await api('POST', '/api/simulate-incoming', { token: ownerAToken, body: { phone: '+15558888', name: 'Rob', body: 'still there?' } });
    assert.strictEqual(r.body.contact.status, 'open');
  });

  // ---- Bot: welcome fires, does not clear awaiting ------------------------
  await test('welcome bot fires on new contact and keeps conversation awaiting', async () => {
    const r = await api('POST', '/api/simulate-incoming', { token: ownerAToken, body: { phone: '+15557777', name: 'Newbie', body: 'first message' } });
    assert.strictEqual(r.body.isNew, true);
    assert.ok(r.body.botReplies.length >= 1, 'welcome bot should reply');
    assert.strictEqual(r.body.contact.last_direction, 'in'); // still awaiting
    const list = await api('GET', '/api/contacts?view=awaiting', { token: ownerAToken });
    assert.ok(list.body.contacts.some((c) => c.id === r.body.contact.id));
  });

  // ---- Quick replies ------------------------------------------------------
  await test('quick reply create, usage counting and per-company scoping', async () => {
    let r = await api('POST', '/api/quick-replies', { token: ownerAToken, body: { title: 'Thanks', body: 'Thank you {name}', shortcut: 'ty' } });
    assert.strictEqual(r.status, 201);
    const id = r.body.quickReply.id;
    r = await api('PATCH', '/api/quick-replies/' + id, { token: ownerAToken, body: { used: true } });
    assert.strictEqual(r.body.quickReply.uses, 1);
    // Company B cannot touch A's quick reply
    r = await api('PATCH', '/api/quick-replies/' + id, { token: ownerBToken, body: { used: true } });
    assert.strictEqual(r.status, 404);
  });

  // ---- Templates + campaigns ---------------------------------------------
  await test('template create normalizes name; empty broadcast segment rejected', async () => {
    let r = await api('POST', '/api/templates', { token: ownerBToken, body: { name: 'Welcome Offer!', body: 'Hi {name}' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.template.name, 'welcome_offer');
    const tid = r.body.template.id;
    // Beta has zero contacts -> broadcast to 'all' should reject as empty
    r = await api('POST', '/api/campaigns', { token: ownerBToken, body: { name: 'Blast', template_id: tid, segment: { type: 'all' } } });
    assert.strictEqual(r.status, 400);
  });

  await test('broadcast sends to a non-empty segment and records counts', async () => {
    // Alpha has contacts. Create template + campaign.
    let t = await api('POST', '/api/templates', { token: ownerAToken, body: { name: 'promo', body: 'Deal for {name}' } });
    const r = await api('POST', '/api/campaigns', { token: ownerAToken, body: { name: 'Promo run', template_id: t.body.template.id, segment: { type: 'all' } } });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.campaign.audience >= 1);
    assert.strictEqual(r.body.campaign.sent, r.body.campaign.audience);
  });

  // ---- Suspension ---------------------------------------------------------
  await test('suspension immediately blocks a live session', async () => {
    await api('PATCH', '/api/admin/companies/' + compA.id, { token: superToken, body: { status: 'suspended' } });
    let r = await api('GET', '/api/me', { token: ownerAToken });
    assert.strictEqual(r.status, 403);
    await api('PATCH', '/api/admin/companies/' + compA.id, { token: superToken, body: { status: 'active' } });
    r = await api('GET', '/api/me', { token: ownerAToken });
    assert.strictEqual(r.status, 200);
  });

  // ---- Impersonation ------------------------------------------------------
  await test('impersonation lands in the right workspace', async () => {
    const r = await api('POST', '/api/admin/companies/' + compA.id + '/impersonate', { token: superToken });
    assert.strictEqual(r.status, 200);
    const me = await api('GET', '/api/me', { token: r.body.token });
    assert.strictEqual(me.body.company.id, compA.id);
  });

  // ---- Deletion requires exact-name confirmation --------------------------
  await test('deleting a client requires exact-name confirmation', async () => {
    let r = await api('DELETE', '/api/admin/companies/' + compB.id, { token: superToken });
    assert.strictEqual(r.status, 400);
    r = await api('DELETE', '/api/admin/companies/' + compB.id + '?confirm=Wrong', { token: superToken });
    assert.strictEqual(r.status, 400);
    r = await api('DELETE', '/api/admin/companies/' + compB.id + '?confirm=' + encodeURIComponent('Beta'), { token: superToken });
    assert.strictEqual(r.status, 200);
    // owner B token now invalid (company gone)
    r = await api('GET', '/api/me', { token: ownerBToken });
    assert.ok(r.status === 401 || r.status === 403);
  });

  await test('platform owner cannot delete their own workspace', async () => {
    const me = await api('GET', '/api/me', { token: superToken });
    const ownId = me.body.company.id;
    const r = await api('DELETE', '/api/admin/companies/' + ownId + '?confirm=' + encodeURIComponent(me.body.company.name), { token: superToken });
    assert.strictEqual(r.status, 403);
  });

  // ---- Webhook ------------------------------------------------------------
  await test('webhook verification rejects a wrong token and accepts the right one', async () => {
    // Set verify token on Alpha via owner settings
    await api('PATCH', '/api/company', { token: ownerAToken, body: { wa_verify_token: 'verify_alpha' } });
    let r = await api('GET', '/webhook/' + compA.id + '?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123', { raw: true });
    assert.strictEqual(r.status, 403);
    r = await api('GET', '/webhook/' + compA.id + '?hub.mode=subscribe&hub.verify_token=verify_alpha&hub.challenge=123', { raw: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, '123');
  });

  await test('webhook inbound (Meta format) creates a contact and fires the welcome bot', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: '15551234567', profile: { name: 'Meta User' } }],
        messages: [{ from: '15551234567', id: 'wamid.TEST1', type: 'text', text: { body: 'hi from meta' } }],
      } }] }],
    };
    const r = await api('POST', '/webhook/' + compA.id, { body: payload, raw: true });
    assert.strictEqual(r.status, 200);
    await sleep(400); // async processing
    const list = await api('GET', '/api/contacts?q=Meta', { token: ownerAToken });
    const c = list.body.contacts.find((x) => x.name === 'Meta User');
    assert.ok(c, 'contact created from webhook');
    assert.strictEqual(c.source, 'WhatsApp Inbound');
    const msgs = await api('GET', '/api/messages/' + c.id, { token: ownerAToken });
    assert.ok(msgs.body.messages.some((m) => m.direction === 'in' && /hi from meta/.test(m.body)));
    assert.ok(msgs.body.messages.some((m) => m.direction === 'out'), 'welcome bot replied');
  });

  // ---- Password reset -----------------------------------------------------
  await test('forgot/reset password flow works (demo delivery)', async () => {
    const r = await api('POST', '/api/auth/forgot', { body: { email: 'alice@alpha.com' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.resetUrl, 'demo delivery should return a reset url');
    const token = r.body.resetUrl.split('/reset/')[1];
    // wrong token rejected
    let bad = await api('POST', '/api/auth/reset', { body: { token: 'nope', password: 'newpass123' } });
    assert.strictEqual(bad.status, 400);
    // valid reset
    const ok = await api('POST', '/api/auth/reset', { body: { token, password: 'newpass123' } });
    assert.strictEqual(ok.status, 200);
    // token cannot be reused
    const reuse = await api('POST', '/api/auth/reset', { body: { token, password: 'again123' } });
    assert.strictEqual(reuse.status, 400);
    // login with new password
    const li = await api('POST', '/api/auth/login', { body: { email: 'alice@alpha.com', password: 'newpass123' } });
    assert.strictEqual(li.status, 200);
    ownerAToken = li.body.token;
  });

  await test('login rate limiting blocks repeated failures with 429', async () => {
    for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', { body: { email: 'rl@test.com', password: 'wrong' } });
    const blocked = await api('POST', '/api/auth/login', { body: { email: 'rl@test.com', password: 'wrong' } });
    assert.strictEqual(blocked.status, 429);
  });

  // ---- Scheduled broadcasts ----------------------------------------------
  await test('scheduled broadcast queues and the scheduler sends it', async () => {
    const t = await api('POST', '/api/templates', { token: ownerAToken, body: { name: 'sched_promo', body: 'Scheduled {name}' } });
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const r = await api('POST', '/api/campaigns', { token: ownerAToken, body: { name: 'Later Blast', template_id: t.body.template.id, segment: { type: 'all' }, scheduled_at: future } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.campaign.status, 'scheduled');
    const campId = r.body.campaign.id;
    // Backdate and run the scheduler.
    await db.query(`UPDATE campaigns SET scheduled_at=(now() AT TIME ZONE 'utc') - interval '1 minute' WHERE id=$1`, [campId]);
    await app.runScheduler();
    const list = await api('GET', '/api/campaigns', { token: ownerAToken });
    const camp = list.body.campaigns.find((c) => c.id === campId);
    assert.strictEqual(camp.status, 'sent');
    assert.ok(camp.sent >= 1);
  });

  await test('scheduled broadcast can be cancelled and is not sent', async () => {
    const t = await api('POST', '/api/templates', { token: ownerAToken, body: { name: 'cancel_promo', body: 'Hi {name}' } });
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const r = await api('POST', '/api/campaigns', { token: ownerAToken, body: { name: 'Cancel Me', template_id: t.body.template.id, segment: { type: 'all' }, scheduled_at: future } });
    const campId = r.body.campaign.id;
    const cx = await api('PATCH', '/api/campaigns/' + campId, { token: ownerAToken, body: { status: 'cancelled' } });
    assert.strictEqual(cx.body.campaign.status, 'cancelled');
    await db.query(`UPDATE campaigns SET scheduled_at=(now() AT TIME ZONE 'utc') - interval '1 minute' WHERE id=$1`, [campId]);
    await app.runScheduler();
    const list = await api('GET', '/api/campaigns', { token: ownerAToken });
    const camp = list.body.campaigns.find((c) => c.id === campId);
    assert.strictEqual(camp.status, 'cancelled');
  });

  await test('past schedule time is rejected', async () => {
    const t = await api('POST', '/api/templates', { token: ownerAToken, body: { name: 'past_promo', body: 'x' } });
    const past = new Date(Date.now() - 1000).toISOString();
    const r = await api('POST', '/api/campaigns', { token: ownerAToken, body: { name: 'Past', template_id: t.body.template.id, segment: { type: 'all' }, scheduled_at: past } });
    assert.strictEqual(r.status, 400);
  });

  // ---- Analytics ----------------------------------------------------------
  await test('analytics returns response time, reply rate and agent performance', async () => {
    const r = await api('GET', '/api/analytics', { token: ownerAToken });
    assert.strictEqual(r.status, 200);
    assert.ok('avgResponseSeconds' in r.body);
    assert.ok('replyRate' in r.body);
    assert.ok(Array.isArray(r.body.agents) && r.body.agents.length >= 1);
    assert.ok(r.body.conversationsOpened >= 1);
  });

  // ---- Wrap up ------------------------------------------------------------
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { for (const [n, e] of failures) console.error('FAIL:', n, '\n', e); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
