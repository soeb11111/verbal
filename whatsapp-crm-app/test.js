// test.js — end-to-end API tests against a real Postgres engine (PGlite/WASM).
// Run: npm test
process.env.PGLITE_TEST = '1';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-long-enough-000000';
process.env.SUPER_ADMIN_EMAIL = 'boss@platform.com';

const app = require('./server');
const dbmod = require('./db');
// Test-only helper: flip the platform sign-up switch without going through the API.
const setSignup = (open) => dbmod.run('UPDATE platform_settings SET registration_open = ? WHERE id = 1', open);

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

let BASE;
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = 'http://127.0.0.1:' + server.address().port;

  // --- health ---
  const health = await call('GET', '/api/health');
  check('health endpoint reports database connected', health.status === 200 && health.data.database === 'connected', JSON.stringify(health.data));

  // --- registration / company workspaces ---
  const regA = await call('POST', '/api/auth/register', {
    body: { companyName: 'Proto21', name: 'Owner A', email: 'ownerA@test.com', password: 'secret1' },
  });
  check('register creates company + owner', regA.status === 200 && !!regA.data.token && regA.data.user.role === 'owner');
  const tokenA = regA.data.token;

  // The first account is always allowed; after that sign-up is closed unless opened.
  const secondSignup = await call('POST', '/api/auth/register', {
    body: { companyName: 'Walk In', name: 'W', email: 'walkin@test.com', password: 'secret1' },
  });
  check('public sign-up closed by default after first account', secondSignup.status === 403);

  await setSignup(true); // open it for the multi-tenant tests below

  const regB = await call('POST', '/api/auth/register', {
    body: { companyName: 'OtherCo', name: 'Owner B', email: 'ownerB@test.com', password: 'secret2' },
  });
  check('second company can register', regB.status === 200);
  const tokenB = regB.data.token;

  const dupe = await call('POST', '/api/auth/register', {
    body: { companyName: 'X', name: 'X', email: 'ownerA@test.com', password: 'secret1' },
  });
  check('duplicate email rejected', dupe.status === 409);

  const shortPw = await call('POST', '/api/auth/register', {
    body: { companyName: 'X', name: 'X', email: 'new@test.com', password: '123' },
  });
  check('short password rejected', shortPw.status === 400);

  // --- me / company ---
  const me = await call('GET', '/api/me', { token: tokenA });
  check('/api/me returns company profile', me.status === 200 && me.data.company.name === 'Proto21');
  check('WhatsApp reports as not configured (demo mode)', me.data.company.wa_configured === false);
  const companyIdA = me.data.company.id;

  check('created_at is a plain string, not a Date object',
    typeof me.data.user.created_at === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(me.data.user.created_at),
    String(me.data.user.created_at));

  // --- auth guards ---
  const noAuth = await call('GET', '/api/contacts');
  check('unauthenticated request blocked', noAuth.status === 401);
  const badToken = await call('GET', '/api/contacts', { token: 'not-a-real-token' });
  check('forged token rejected', badToken.status === 401);

  // --- team management ---
  const addAgent = await call('POST', '/api/users', {
    token: tokenA, body: { name: 'Sara', email: 'sara@test.com', password: 'secret3', role: 'agent' },
  });
  check('admin can add a user', addAgent.status === 200 && addAgent.data.role === 'agent');
  const agentId = addAgent.data.id;

  const agentLogin = await call('POST', '/api/auth/login', { body: { email: 'sara@test.com', password: 'secret3' } });
  check('new user can log in', agentLogin.status === 200 && !!agentLogin.data.token);
  const tokenAgent = agentLogin.data.token;

  const agentAddUser = await call('POST', '/api/users', {
    token: tokenAgent, body: { name: 'Hacker', email: 'hack@test.com', password: 'secret9' },
  });
  check('agent cannot create users', agentAddUser.status === 403);

  const agentEditCompany = await call('PATCH', '/api/company', { token: tokenAgent, body: { name: 'Hijacked' } });
  check('agent cannot edit company settings', agentEditCompany.status === 403);

  const crossCompany = await call('DELETE', `/api/users/${agentId}`, { token: tokenB });
  check("company B cannot delete company A's user", crossCompany.status === 404);

  const usersA = await call('GET', '/api/users', { token: tokenA });
  check('team list scoped to own company', usersA.data.length === 2, `got ${usersA.data.length}`);

  const ownerRow = usersA.data.find((u) => u.role === 'owner');
  const delOwner = await call('DELETE', `/api/users/${ownerRow.id}`, { token: tokenA });
  check('owner account cannot be removed', delOwner.status === 403);

  // --- contacts + isolation ---
  const contact = await call('POST', '/api/contacts', {
    token: tokenA, body: { name: 'Ahmed', phone: '+971552348890', company: 'Falcon' },
  });
  check('contact created', contact.status === 200 && contact.data.id > 0);
  const contactId = contact.data.id;

  const contactsB = await call('GET', '/api/contacts', { token: tokenB });
  check('company B cannot see company A contacts', contactsB.data.length === 0, `got ${contactsB.data.length}`);

  const msgCross = await call('GET', `/api/messages/${contactId}`, { token: tokenB });
  check("company B cannot read company A's messages", msgCross.status === 404);

  await call('PATCH', `/api/contacts/${contactId}`, { token: tokenA, body: { stage: 'Qualified', tags: ['VIP'] } });
  const contactsA = await call('GET', '/api/contacts', { token: tokenA });
  const updated = contactsA.data.find((c) => c.id === contactId);
  check('contact stage + tags saved', updated.stage === 'Qualified' && updated.tags[0] === 'VIP');

  // --- messaging ---
  const send = await call('POST', `/api/messages/${contactId}`, { token: tokenA, body: { body: 'Hello Ahmed!' } });
  check('outbound message stored in demo mode', send.status === 200 && send.data.demo === true);

  const note = await call('POST', `/api/messages/${contactId}`, {
    token: tokenA, body: { body: 'Budget approx 50k', direction: 'note' },
  });
  check('internal note saved', note.status === 200);

  const thread = await call('GET', `/api/messages/${contactId}`, { token: tokenA });
  check('conversation returns both message and note', thread.data.length === 2);
  check('message records who sent it', thread.data[0].sender_name === 'Owner A', String(thread.data[0].sender_name));

  // --- bots via simulator ---
  const sim = await call('POST', '/api/simulate-incoming', {
    token: tokenA, body: { phone: '+971501112233', name: 'Walk-in Lead', body: 'hello there' },
  });
  check('simulated inbound triggers welcome bot', sim.status === 200 && sim.data.botReplied === true);

  const newBot = await call('POST', '/api/bots', {
    token: tokenA, body: { name: 'Pricing', trigger_type: 'keyword', keyword: 'price', reply: 'Our price list: ...' },
  });
  check('keyword bot rule created', newBot.status === 200);

  const sim2 = await call('POST', '/api/simulate-incoming', {
    token: tokenA, body: { contactId, body: 'what is the price?' },
  });
  check('keyword bot fires on matching message', sim2.data.botReplied === true);

  const sim3 = await call('POST', '/api/simulate-incoming', {
    token: tokenA, body: { contactId, body: 'thanks, bye' },
  });
  check('bot stays silent on non-matching message', sim3.data.botReplied === false);

  const botsList = await call('GET', '/api/bots', { token: tokenA });
  const pricingBot = botsList.data.find((b) => b.name === 'Pricing');
  check('bot run counter increments', pricingBot.runs === 1, `runs=${pricingBot.runs}`);

  await call('PATCH', `/api/bots/${pricingBot.id}`, { token: tokenA, body: { active: false } });
  const sim4 = await call('POST', '/api/simulate-incoming', { token: tokenA, body: { contactId, body: 'price please' } });
  check('paused bot does not reply', sim4.data.botReplied === false);

  // --- templates + campaigns ---
  const tpl = await call('POST', '/api/templates', {
    token: tokenA, body: { name: 'Welcome Offer', category: 'Marketing', body: 'Hi {{1}}, 15% off!' },
  });
  check('template created with normalised name', tpl.status === 200 && tpl.data.name === 'welcome_offer');

  const camp = await call('POST', '/api/campaigns', {
    token: tokenA, body: { name: 'Test Blast', template_id: tpl.data.id, segment: 'All Contacts' },
  });
  check('campaign sends to all contacts', camp.status === 200 && camp.data.sent === 2 && camp.data.failed === 0,
    JSON.stringify(camp.data));

  const campTag = await call('POST', '/api/campaigns', {
    token: tokenA, body: { name: 'VIP only', template_id: tpl.data.id, segment: 'Tag: VIP' },
  });
  check('tag segment targets only tagged contacts', campTag.data.sent === 1, `sent=${campTag.data.sent}`);

  const campEmpty = await call('POST', '/api/campaigns', {
    token: tokenA, body: { name: 'Nobody', template_id: tpl.data.id, segment: 'Tag: DoesNotExist' },
  });
  check('empty segment rejected', campEmpty.status === 400);

  const agentCampaign = await call('POST', '/api/campaigns', {
    token: tokenAgent, body: { name: 'X', template_id: tpl.data.id, segment: 'All Contacts' },
  });
  check('agent cannot launch campaigns', agentCampaign.status === 403);

  // --- webhook ---
  await call('PATCH', '/api/company', { token: tokenA, body: { wa_verify_token: 'my-verify-token' } });
  const badVerify = await fetch(`${BASE}/webhook/${companyIdA}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`);
  check('webhook rejects wrong verify token', badVerify.status === 403);

  const goodVerify = await fetch(`${BASE}/webhook/${companyIdA}?hub.mode=subscribe&hub.verify_token=my-verify-token&hub.challenge=CHALLENGE123`);
  check('webhook verification handshake succeeds',
    goodVerify.status === 200 && (await goodVerify.text()) === 'CHALLENGE123');

  const waPayload = {
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'WA Customer' } }],
      messages: [{ from: '971509998877', id: 'wamid.TEST1', type: 'text', text: { body: 'hi there' } }],
    } }] }],
  };
  const hook = await fetch(`${BASE}/webhook/${companyIdA}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload),
  });
  check('webhook accepts Meta payload', hook.status === 200);
  await new Promise((r) => setTimeout(r, 400)); // async processing

  const afterHook = await call('GET', '/api/contacts', { token: tokenA });
  const waContact = afterHook.data.find((c) => c.phone === '+971509998877');
  check('inbound WhatsApp message auto-creates contact', !!waContact && waContact.name === 'WA Customer');
  check('inbound message marks conversation unread', waContact && waContact.unread >= 1, `unread=${waContact?.unread}`);

  const waThread = await call('GET', `/api/messages/${waContact.id}`, { token: tokenA });
  check('inbound message + bot welcome reply both stored', waThread.data.length === 2, `got ${waThread.data.length}`);

  // duplicate delivery-status update should not error
  const statusHook = await fetch(`${BASE}/webhook/${companyIdA}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.TEST1', status: 'delivered' }] } }] }] }),
  });
  check('delivery status webhook handled', statusHook.status === 200);

  // --- deactivate / remove users ---
  await call('PATCH', `/api/users/${agentId}`, { token: tokenA, body: { active: false } });
  const deactivatedLogin = await call('POST', '/api/auth/login', { body: { email: 'sara@test.com', password: 'secret3' } });
  check('deactivated user cannot log in', deactivatedLogin.status === 403);

  const oldTokenUse = await call('GET', '/api/contacts', { token: tokenAgent });
  check('deactivated user existing session is revoked', oldTokenUse.status === 401);

  await call('PATCH', `/api/users/${agentId}`, { token: tokenA, body: { active: true, role: 'admin' } });
  const reLogin = await call('POST', '/api/auth/login', { body: { email: 'sara@test.com', password: 'secret3' } });
  check('reactivated user can log in again', reLogin.status === 200);

  const promoted = (await call('GET', '/api/users', { token: tokenA })).data.find((u) => u.id === agentId);
  check('role change to admin persisted', promoted.role === 'admin');

  const del = await call('DELETE', `/api/users/${agentId}`, { token: tokenA });
  check('user removed', del.status === 200);
  const removedLogin = await call('POST', '/api/auth/login', { body: { email: 'sara@test.com', password: 'secret3' } });
  check('removed user cannot log in', removedLogin.status === 401);

  // --- stats ---
  const stats = await call('GET', '/api/stats', { token: tokenA });
  check('stats returns numbers (not strings)',
    typeof stats.data.contacts === 'number' && typeof stats.data.unread === 'number' && stats.data.contacts === 3,
    JSON.stringify(stats.data));
  check('stats counts campaigns', stats.data.campaigns === 2, `got ${stats.data.campaigns}`);

  const statsB = await call('GET', '/api/stats', { token: tokenB });
  check('company B stats are separate', statsB.data.contacts === 0 && statsB.data.users === 1);

  // --- persistence across a simulated restart (same DB) ---
  const loginAgain = await call('POST', '/api/auth/login', { body: { email: 'ownerA@test.com', password: 'secret1' } });
  check('data persists — owner can log back in', loginAgain.status === 200);
  const persisted = await call('GET', '/api/contacts', { token: loginAgain.data.token });
  check('contacts still present after re-login', persisted.data.length === 3, `got ${persisted.data.length}`);

  // ============================================================
  //                    SUPER ADMIN PLATFORM
  // ============================================================

  const regSuper = await call('POST', '/api/auth/register', {
    body: { companyName: 'Platform HQ', name: 'Boss', email: 'boss@platform.com', password: 'secret5' },
  });
  check('platform owner can always register', regSuper.status === 200);
  const tokenSuper = regSuper.data.token;

  const superMe = await call('GET', '/api/me', { token: tokenSuper });
  check('platform owner flagged as super admin', superMe.data.isSuperAdmin === true);
  const normalMe = await call('GET', '/api/me', { token: tokenA });
  check('ordinary owner is not a super admin', normalMe.data.isSuperAdmin === false);

  const sneaky = await call('GET', '/api/admin/companies', { token: tokenA });
  check('ordinary owner blocked from admin API', sneaky.status === 403);

  // --- registration control ---
  await call('PATCH', '/api/admin/settings', { token: tokenSuper, body: { registrationOpen: false } });
  const closedSignup = await call('POST', '/api/auth/register', {
    body: { companyName: 'Random', name: 'R', email: 'random@x.com', password: 'secret6' },
  });
  check('platform owner can close public sign-up', closedSignup.status === 403);

  const cfg = await call('GET', '/api/auth/config');
  check('auth config reports sign-up closed', cfg.data.registrationOpen === false);

  await call('PATCH', '/api/admin/settings', { token: tokenSuper, body: { registrationOpen: true } });
  const openSignup = await call('POST', '/api/auth/register', {
    body: { companyName: 'Self Serve Co', name: 'S', email: 'self@x.com', password: 'secret7' },
  });
  check('sign-up works once opened', openSignup.status === 200);
  await call('PATCH', '/api/admin/settings', { token: tokenSuper, body: { registrationOpen: false } });
  const closedAgain = await call('POST', '/api/auth/register', {
    body: { companyName: 'Nope', name: 'N', email: 'nope@x.com', password: 'secret8' },
  });
  check('sign-up closes again on demand', closedAgain.status === 403);

  const agentSettings = await call('PATCH', '/api/admin/settings', { token: tokenA, body: { registrationOpen: true } });
  check('non-super-admin cannot change platform settings', agentSettings.status === 403);

  // --- creating clients ---
  const newClient = await call('POST', '/api/admin/companies', {
    token: tokenSuper,
    body: { companyName: 'Falcon Interiors', ownerName: 'Ahmed', email: 'ahmed@falcon.com', password: 'clientpw1', plan: 'starter' },
  });
  check('super admin creates a client workspace', newClient.status === 200 && newClient.data.companyId > 0);
  const clientId = newClient.data.companyId;

  const clientLogin = await call('POST', '/api/auth/login', { body: { email: 'ahmed@falcon.com', password: 'clientpw1' } });
  check('client owner can log in with issued credentials', clientLogin.status === 200);
  let tokenClient = clientLogin.data.token;

  const clientMe = await call('GET', '/api/me', { token: tokenClient });
  check('client gets the plan we assigned', clientMe.data.company.plan === 'starter');
  check('starter plan excludes broadcast + automation modules',
    !clientMe.data.company.modules.includes('broadcast') && !clientMe.data.company.modules.includes('automation'),
    JSON.stringify(clientMe.data.company.modules));

  // --- module gating ---
  const blockedBroadcast = await call('GET', '/api/campaigns', { token: tokenClient });
  check('disabled module blocked server-side', blockedBroadcast.status === 403);
  const blockedBots = await call('GET', '/api/bots', { token: tokenClient });
  check('disabled automation module blocked server-side', blockedBots.status === 403);
  const allowedContacts = await call('GET', '/api/contacts', { token: tokenClient });
  check('enabled module still reachable', allowedContacts.status === 200);

  // --- plan limits ---
  await call('PATCH', `/api/admin/companies/${clientId}`, {
    token: tokenSuper, body: { max_users: 2, max_contacts: 2 },
  });
  const u1 = await call('POST', '/api/users', {
    token: tokenClient, body: { name: 'Agent1', email: 'a1@falcon.com', password: 'secret1' },
  });
  check('client can add a user within plan limit', u1.status === 200);
  const u2 = await call('POST', '/api/users', {
    token: tokenClient, body: { name: 'Agent2', email: 'a2@falcon.com', password: 'secret1' },
  });
  check('user creation blocked at plan limit', u2.status === 402, JSON.stringify(u2.data));

  await call('POST', '/api/contacts', { token: tokenClient, body: { name: 'C1', phone: '+971500000001' } });
  await call('POST', '/api/contacts', { token: tokenClient, body: { name: 'C2', phone: '+971500000002' } });
  const c3 = await call('POST', '/api/contacts', { token: tokenClient, body: { name: 'C3', phone: '+971500000003' } });
  check('contact creation blocked at plan limit', c3.status === 402, JSON.stringify(c3.data));

  await call('PATCH', `/api/admin/companies/${clientId}`, { token: tokenSuper, body: { plan: 'pro' } });
  const afterUpgrade = await call('GET', '/api/me', { token: tokenClient });
  check('plan upgrade raises limits', afterUpgrade.data.company.max_contacts > 2);
  check('plan upgrade restores modules', afterUpgrade.data.company.modules.includes('broadcast'));
  const c4 = await call('POST', '/api/contacts', { token: tokenClient, body: { name: 'C3', phone: '+971500000003' } });
  check('contacts can be added again after upgrade', c4.status === 200);

  // --- usage reporting ---
  const clientList = await call('GET', '/api/admin/companies', { token: tokenSuper });
  const falcon = clientList.data.find((c) => c.id === clientId);
  check('admin list reports client usage', falcon.users === 2 && falcon.contacts === 3,
    `users=${falcon.users} contacts=${falcon.contacts}`);
  check('admin list includes owner email', falcon.owner_email === 'ahmed@falcon.com');

  const overview = await call('GET', '/api/admin/overview', { token: tokenSuper });
  check('platform overview matches the client list',
    overview.data.companies === clientList.data.length && overview.data.companies >= 4,
    JSON.stringify(overview.data));
  check('platform overview counts active vs suspended',
    overview.data.active + overview.data.suspended === overview.data.companies);

  // --- suspension ---
  await call('PATCH', `/api/admin/companies/${clientId}`, { token: tokenSuper, body: { status: 'suspended' } });
  const suspendedAccess = await call('GET', '/api/contacts', { token: tokenClient });
  check('suspended client is locked out', suspendedAccess.status === 403, JSON.stringify(suspendedAccess.data));
  const suspendedLogin = await call('POST', '/api/auth/login', { body: { email: 'ahmed@falcon.com', password: 'clientpw1' } });
  check('suspended client login returns a token but no access', suspendedLogin.status === 200);
  const stillBlocked = await call('GET', '/api/me', { token: suspendedLogin.data.token });
  check('suspended client blocked even with fresh login', stillBlocked.status === 403);

  await call('PATCH', `/api/admin/companies/${clientId}`, { token: tokenSuper, body: { status: 'active' } });
  const reactivated = await call('GET', '/api/contacts', { token: tokenClient });
  check('reactivated client regains access', reactivated.status === 200);

  // --- password reset ---
  const reset = await call('POST', `/api/admin/companies/${clientId}/reset-password`, {
    token: tokenSuper, body: { password: 'brandnewpw' },
  });
  check('super admin can reset a client owner password', reset.status === 200);
  const oldPw = await call('POST', '/api/auth/login', { body: { email: 'ahmed@falcon.com', password: 'clientpw1' } });
  check('old password stops working after reset', oldPw.status === 401);
  const newPw = await call('POST', '/api/auth/login', { body: { email: 'ahmed@falcon.com', password: 'brandnewpw' } });
  check('new password works after reset', newPw.status === 200);
  tokenClient = newPw.data.token;

  // --- impersonation ---
  const imp = await call('POST', `/api/admin/companies/${clientId}/impersonate`, { token: tokenSuper });
  check('super admin can open a client workspace', imp.status === 200 && !!imp.data.token);
  const impMe = await call('GET', '/api/me', { token: imp.data.token });
  check('impersonated session lands in the client workspace', impMe.data.company.id === clientId);
  check('impersonated session is not super admin', impMe.data.isSuperAdmin === false);

  const impBlocked = await call('POST', `/api/admin/companies/${clientId}/impersonate`, { token: tokenA });
  check('ordinary user cannot impersonate', impBlocked.status === 403);

  // --- validation ---
  const badPlan = await call('PATCH', `/api/admin/companies/${clientId}`, { token: tokenSuper, body: { plan: 'unlimited-free' } });
  check('unknown plan rejected', badPlan.status === 400);
  const badModule = await call('PATCH', `/api/admin/companies/${clientId}`, { token: tokenSuper, body: { modules: ['inbox', 'hacking'] } });
  check('invalid module list rejected', badModule.status === 400);
  const dupClient = await call('POST', '/api/admin/companies', {
    token: tokenSuper, body: { companyName: 'Dup', ownerName: 'D', email: 'ahmed@falcon.com', password: 'secret1' },
  });
  check('duplicate client email rejected', dupClient.status === 409);

  // --- deletion ---
  const wrongName = await call('DELETE', `/api/admin/companies/${clientId}?confirm=WrongName`, { token: tokenSuper });
  check('deletion requires exact client name', wrongName.status === 400);

  const selfDelete = await call('DELETE', `/api/admin/companies/${superMe.data.company.id}?confirm=Platform HQ`, { token: tokenSuper });
  check('super admin cannot delete own workspace', selfDelete.status === 400);

  const del2 = await call('DELETE', `/api/admin/companies/${clientId}?confirm=Falcon%20Interiors`, { token: tokenSuper });
  check('client deleted with correct confirmation', del2.status === 200, JSON.stringify(del2.data));
  const goneLogin = await call('POST', '/api/auth/login', { body: { email: 'ahmed@falcon.com', password: 'brandnewpw' } });
  check('deleted client cannot log in', goneLogin.status === 401);
  const listAfter = await call('GET', '/api/admin/companies', { token: tokenSuper });
  check('deleted client removed from platform list', !listAfter.data.find((c) => c.id === clientId));

  server.close();
  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});
