// whatsapp.js — Meta WhatsApp Cloud API client.
//
// DEMO MODE: when a company has no credentials configured, nothing is ever sent
// to Meta. The caller (server.js) is responsible for storing the message with
// status 'demo'. This module only performs a real network call when a company
// has both an access token and a phone number id.

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

function isConfigured(company) {
  return !!(company && company.wa_token && company.wa_phone_id);
}

// Send a free-form text message (only valid inside the 24h customer window).
// Returns { demo:true } when not configured, otherwise { ok, wa_message_id, error }.
async function sendText(company, toPhone, body) {
  if (!isConfigured(company)) return { demo: true };
  try {
    const res = await fetch(`${GRAPH_BASE}/${company.wa_phone_id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${company.wa_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(toPhone).replace(/[^0-9]/g, ''),
        type: 'text',
        text: { body },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data && data.error ? data.error.message : 'send failed' };
    const id = data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, wa_message_id: id };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Send a template message by name (required outside the 24h window / broadcasts).
async function sendTemplate(company, toPhone, templateName, langCode) {
  if (!isConfigured(company)) return { demo: true };
  try {
    const res = await fetch(`${GRAPH_BASE}/${company.wa_phone_id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${company.wa_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(toPhone).replace(/[^0-9]/g, ''),
        type: 'template',
        template: { name: templateName, language: { code: langCode || 'en_US' } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data && data.error ? data.error.message : 'send failed' };
    const id = data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, wa_message_id: id };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { isConfigured, sendText, sendTemplate, GRAPH_BASE };
