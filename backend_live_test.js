// backend_live_test.js — Test new features against live public endpoint
// Tests: Password reset, Login rate limiting, Scheduled broadcasts, Analytics

const BASE_URL = 'https://verbal-crm.preview.emergentagent.com';

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    failures.push([name, e]);
    console.log('  ✗', name, '\n     ' + (e && e.message));
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { _raw: text };
  }
  
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\n🧪 Testing Verbal CRM - New Features\n');
  console.log('Endpoint:', BASE_URL);
  console.log('');

  // ---- Setup: Login as platform owner ----
  let ownerToken = '';
  await test('Login as platform owner (sohaibak5@gmail.com)', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: 'sohaibak5@gmail.com', password: 'verbal123' }
    });
    if (r.status !== 200) throw new Error('Login failed: ' + (r.body.error || r.status));
    if (!r.body.token) throw new Error('No token returned');
    ownerToken = r.body.token;
  });

  // ---- Feature 1: PASSWORD RESET (self-service) ----
  console.log('\n📧 Password Reset Tests:');
  
  await test('POST /api/auth/forgot returns 200 with generic message', async () => {
    const r = await api('POST', '/api/auth/forgot', {
      body: { email: 'sohaibak5@gmail.com' }
    });
    if (r.status !== 200) throw new Error('Expected 200, got ' + r.status);
    if (!r.body.message) throw new Error('No message in response');
  });

  await test('POST /api/auth/forgot for known email returns demo reset URL', async () => {
    const r = await api('POST', '/api/auth/forgot', {
      body: { email: 'sohaibak5@gmail.com' }
    });
    if (r.status !== 200) throw new Error('Expected 200, got ' + r.status);
    if (!r.body.demo) throw new Error('Expected demo:true in response');
    if (!r.body.resetUrl) throw new Error('Expected resetUrl in demo response');
    if (!r.body.resetUrl.includes('/#/reset/')) throw new Error('Invalid reset URL format');
  });

  let resetToken = '';
  await test('Extract reset token from demo URL', async () => {
    const r = await api('POST', '/api/auth/forgot', {
      body: { email: 'sohaibak5@gmail.com' }
    });
    const url = r.body.resetUrl;
    resetToken = url.split('/#/reset/')[1];
    if (!resetToken || resetToken.length < 32) throw new Error('Invalid token extracted');
  });

  await test('POST /api/auth/reset with invalid token returns 400', async () => {
    const r = await api('POST', '/api/auth/reset', {
      body: { token: 'invalid_token_12345', password: 'newpass123' }
    });
    if (r.status !== 400) throw new Error('Expected 400, got ' + r.status);
  });

  await test('POST /api/auth/reset with valid token and short password returns 400', async () => {
    const r = await api('POST', '/api/auth/reset', {
      body: { token: resetToken, password: '123' }
    });
    if (r.status !== 400) throw new Error('Expected 400 for short password, got ' + r.status);
  });

  await test('POST /api/auth/reset with valid token succeeds', async () => {
    const r = await api('POST', '/api/auth/reset', {
      body: { token: resetToken, password: 'verbal123' }
    });
    if (r.status !== 200) throw new Error('Expected 200, got ' + r.status);
    if (!r.body.ok) throw new Error('Expected ok:true');
  });

  await test('POST /api/auth/reset cannot reuse token (400)', async () => {
    const r = await api('POST', '/api/auth/reset', {
      body: { token: resetToken, password: 'another123' }
    });
    if (r.status !== 400) throw new Error('Expected 400 for reused token, got ' + r.status);
  });

  await test('Login with new password works', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: 'sohaibak5@gmail.com', password: 'verbal123' }
    });
    if (r.status !== 200) throw new Error('Login with new password failed: ' + r.status);
    ownerToken = r.body.token;
  });

  // ---- Feature 2: LOGIN RATE LIMITING ----
  console.log('\n🚦 Login Rate Limiting Tests:');
  
  const testEmail = 'ratelimit_test_' + Date.now() + '@test.com';
  
  await test('5 failed login attempts return 429', async () => {
    for (let i = 0; i < 5; i++) {
      await api('POST', '/api/auth/login', {
        body: { email: testEmail, password: 'wrongpassword' }
      });
    }
    const r = await api('POST', '/api/auth/login', {
      body: { email: testEmail, password: 'wrongpassword' }
    });
    if (r.status !== 429) throw new Error('Expected 429 after 5 failures, got ' + r.status);
    if (!r.body.error || !r.body.error.includes('Too many')) {
      throw new Error('Expected rate limit error message');
    }
  });

  // ---- Feature 3: SCHEDULED BROADCASTS ----
  console.log('\n📅 Scheduled Broadcasts Tests:');
  
  let templateId = null;
  await test('Create a test template for broadcasts', async () => {
    const r = await api('POST', '/api/templates', {
      token: ownerToken,
      body: { name: 'test_scheduled_' + Date.now(), body: 'Test message {name}' }
    });
    if (r.status !== 201) throw new Error('Template creation failed: ' + r.status);
    templateId = r.body.template.id;
  });

  await test('POST /api/campaigns with past scheduled_at returns 400', async () => {
    const past = new Date(Date.now() - 10000).toISOString();
    const r = await api('POST', '/api/campaigns', {
      token: ownerToken,
      body: {
        name: 'Past Campaign',
        template_id: templateId,
        segment: { type: 'all' },
        scheduled_at: past
      }
    });
    if (r.status !== 400) throw new Error('Expected 400 for past schedule, got ' + r.status);
  });

  let scheduledCampaignId = null;
  await test('POST /api/campaigns with future scheduled_at returns status "scheduled"', async () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const r = await api('POST', '/api/campaigns', {
      token: ownerToken,
      body: {
        name: 'Future Campaign ' + Date.now(),
        template_id: templateId,
        segment: { type: 'all' },
        scheduled_at: future
      }
    });
    if (r.status !== 201) throw new Error('Campaign creation failed: ' + r.status);
    if (r.body.campaign.status !== 'scheduled') {
      throw new Error('Expected status "scheduled", got ' + r.body.campaign.status);
    }
    if (r.body.campaign.sent !== 0) throw new Error('Scheduled campaign should have sent=0');
    scheduledCampaignId = r.body.campaign.id;
  });

  await test('PATCH /api/campaigns/:id to cancel scheduled campaign', async () => {
    const r = await api('PATCH', '/api/campaigns/' + scheduledCampaignId, {
      token: ownerToken,
      body: { status: 'cancelled' }
    });
    if (r.status !== 200) throw new Error('Cancel failed: ' + r.status);
    if (r.body.campaign.status !== 'cancelled') {
      throw new Error('Expected status "cancelled", got ' + r.body.campaign.status);
    }
  });

  await test('PATCH /api/campaigns/:id cannot cancel non-scheduled campaign', async () => {
    // Create an immediate campaign first
    const r1 = await api('POST', '/api/campaigns', {
      token: ownerToken,
      body: {
        name: 'Immediate Campaign ' + Date.now(),
        template_id: templateId,
        segment: { type: 'all' }
      }
    });
    if (r1.status !== 201) throw new Error('Immediate campaign creation failed');
    
    const r2 = await api('PATCH', '/api/campaigns/' + r1.body.campaign.id, {
      token: ownerToken,
      body: { status: 'cancelled' }
    });
    if (r2.status !== 400) throw new Error('Expected 400 when cancelling non-scheduled, got ' + r2.status);
  });

  // ---- Feature 4: ANALYTICS ----
  console.log('\n📊 Analytics Tests:');
  
  await test('GET /api/analytics returns all required fields', async () => {
    const r = await api('GET', '/api/analytics', { token: ownerToken });
    if (r.status !== 200) throw new Error('Analytics request failed: ' + r.status);
    
    const required = [
      'avgResponseSeconds',
      'conversationsOpened',
      'conversationsReplied',
      'replyRate',
      'inbound30d',
      'outbound30d',
      'resolvedTotal',
      'agents'
    ];
    
    for (const field of required) {
      if (!(field in r.body)) throw new Error('Missing field: ' + field);
    }
    
    if (!Array.isArray(r.body.agents)) throw new Error('agents should be an array');
    if (r.body.agents.length === 0) throw new Error('Expected at least one agent');
    
    const agent = r.body.agents[0];
    const agentFields = ['id', 'name', 'role', 'sent', 'resolved', 'assigned'];
    for (const field of agentFields) {
      if (!(field in agent)) throw new Error('Agent missing field: ' + field);
    }
  });

  // ---- Feature 5: REGRESSION - Verify existing features still work ----
  console.log('\n🔄 Regression Tests:');
  
  await test('Dashboard stats endpoint still works', async () => {
    const r = await api('GET', '/api/stats', { token: ownerToken });
    if (r.status !== 200) throw new Error('Stats failed: ' + r.status);
    if (!('contacts' in r.body)) throw new Error('Missing contacts field');
  });

  await test('Contacts list endpoint still works', async () => {
    const r = await api('GET', '/api/contacts', { token: ownerToken });
    if (r.status !== 200) throw new Error('Contacts list failed: ' + r.status);
    if (!Array.isArray(r.body.contacts)) throw new Error('contacts should be an array');
  });

  await test('Quick replies endpoint still works', async () => {
    const r = await api('GET', '/api/quick-replies', { token: ownerToken });
    if (r.status !== 200) throw new Error('Quick replies failed: ' + r.status);
    if (!Array.isArray(r.body.quickReplies)) throw new Error('quickReplies should be an array');
  });

  await test('Templates endpoint still works', async () => {
    const r = await api('GET', '/api/templates', { token: ownerToken });
    if (r.status !== 200) throw new Error('Templates failed: ' + r.status);
    if (!Array.isArray(r.body.templates)) throw new Error('templates should be an array');
  });

  await test('Bots endpoint still works', async () => {
    const r = await api('GET', '/api/bots', { token: ownerToken });
    if (r.status !== 200) throw new Error('Bots failed: ' + r.status);
    if (!Array.isArray(r.body.bots)) throw new Error('bots should be an array');
  });

  await test('Team endpoint still works', async () => {
    const r = await api('GET', '/api/users', { token: ownerToken });
    if (r.status !== 200) throw new Error('Users failed: ' + r.status);
    if (!Array.isArray(r.body.users)) throw new Error('users should be an array');
  });

  await test('Campaigns endpoint still works', async () => {
    const r = await api('GET', '/api/campaigns', { token: ownerToken });
    if (r.status !== 200) throw new Error('Campaigns failed: ' + r.status);
    if (!Array.isArray(r.body.campaigns)) throw new Error('campaigns should be an array');
  });

  // ---- Summary ----
  console.log('\n' + '='.repeat(60));
  console.log(`\n✅ ${passed} passed, ❌ ${failed} failed\n`);
  
  if (failed > 0) {
    console.log('Failures:');
    for (const [name, err] of failures) {
      console.error('  ✗', name);
      console.error('    ', err.message);
    }
    process.exit(1);
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
