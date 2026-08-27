// uitest.js — UI suite. Loads public/index.html in jsdom against the real API
// (Express app running in-process on PGlite), then walks every page, opens a
// conversation, sends a message, resolves it and uses a quick reply.
// Fails on any console error or unhandled rejection.
//
//   npm run uitest

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_key_that_is_definitely_over_32_chars_long';
process.env.SUPER_ADMIN_EMAIL = 'super@test.com';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  \u2713', name); }
  catch (e) { failed++; failures.push([name, e]); console.log('  \u2717', name, '\n     ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000, step = 60) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (_) {} await sleep(step); }
  throw new Error('waitFor timed out');
}

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { JSDOM } = require('jsdom');
  const pg = new PGlite();
  const db = require('./db');
  db.useAdapter({ query: (t, p) => pg.query(t, p) });
  await db.ensureSchema();
  const app = require('./server');
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  // Seed data through the real API.
  const jreq = async (method, p, { token, body } = {}) => {
    const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const reg = await jreq('POST', '/api/auth/register', { body: { companyName: 'UI Co', name: 'Uma', email: 'uma@ui.com', password: 'secret123' } });
  const token = reg.body.token;
  await jreq('POST', '/api/simulate-incoming', { token, body: { phone: '+15550100', name: 'Testy McTest', body: 'hello I need help' } });

  // Load the single-file front-end in jsdom.
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const consoleErrors = [];
  const dom = new JSDOM(html, {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, opts) => fetch(u.startsWith('http') ? u : BASE + u, opts);
      window.confirm = () => true;
      window.alert = () => {};
      window.scrollTo = () => {};
      const err = window.console.error.bind(window.console);
      window.console.error = (...a) => { consoleErrors.push(a.join(' ')); err(...a); };
      window.addEventListener('unhandledrejection', (e) => { consoleErrors.push('unhandledrejection: ' + (e.reason && e.reason.message)); });
      window.addEventListener('error', (e) => { consoleErrors.push('error: ' + (e.message || e.error)); });
    },
  });
  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.from(doc.querySelectorAll(s));
  const clickNav = (v) => { const n = doc.querySelector(`.navitem[data-v="${v}"]`); if (!n) throw new Error('nav not found: ' + v); n.click(); };

  await test('auth screen renders', async () => {
    await waitFor(() => $('.auth-card'));
    assert.ok($('#login-form'));
  });

  await test('login lands on the dashboard', async () => {
    await waitFor(() => $('#login-form'));
    $('#login-form input[name="email"]').value = 'uma@ui.com';
    $('#login-form input[name="password"]').value = 'secret123';
    $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => $('.rail') && $('.kpis'));
    assert.ok(/Home/.test($('.topbar .title').textContent));
  });

  await test('every page renders without errors', async () => {
    for (const v of ['chats', 'customers', 'broadcast', 'templates', 'bots', 'team', 'settings', 'dashboard']) {
      clickNav(v);
      await waitFor(() => { const c = $('#content'); return c && !c.querySelector('.spinner') && c.innerHTML.length > 20; });
      await sleep(120);
    }
  });

  await test('open a conversation, send a message, resolve it', async () => {
    clickNav('chats');
    await waitFor(() => $('#chat-list .chatrow'));
    $('#chat-list .chatrow').click();
    await waitFor(() => $('#composer-input') && $('#msgs'));
    const before = $$('#msgs .bubble').length;
    $('#composer-input').value = 'Sure, happy to help!';
    $('#send-btn').click();
    await waitFor(() => $$('#msgs .bubble').length > before);
    // resolve
    $('#resolve-btn').click();
    await waitFor(() => $('#resolve-btn') && /Reopen/.test($('#resolve-btn').textContent));
    assert.ok(/Reopen/.test($('#resolve-btn').textContent));
  });

  await test('use a quick reply from the composer', async () => {
    // reopen first so composer is active
    if (/Reopen/.test($('#resolve-btn').textContent)) { $('#resolve-btn').click(); await waitFor(() => /Resolve/.test($('#resolve-btn').textContent)); }
    const input = $('#composer-input');
    input.value = '/';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => $('#qr-pop') && !$('#qr-pop').classList.contains('hidden') && $('.qr-item'));
    $('.qr-item').click();
    await waitFor(() => $('#composer-input').value && $('#composer-input').value[0] !== '/');
    assert.ok($('#composer-input').value.length > 1);
  });

  server.close();
  window.close();
  if (consoleErrors.length) { console.error('\nConsole errors detected:'); consoleErrors.forEach((e) => console.error('  -', e)); failed++; failures.push(['no console errors', new Error(consoleErrors[0])]); }
  else console.log('  \u2713 no console errors or unhandled rejections');

  console.log(`\n${passed}${consoleErrors.length ? '' : ' + 1'} passed, ${failed} failed`);
  if (failed) { for (const [n, e] of failures) console.error('FAIL:', n, '\n', e && e.message); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
