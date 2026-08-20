// whatsapp.js — Meta WhatsApp Cloud API integration
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
const GRAPH = 'https://graph.facebook.com/v21.0';

function isConfigured(company) {
  return !!(company.wa_token && company.wa_phone_id);
}

// Send a free-form text message (allowed within 24h customer service window)
async function sendText(company, toPhone, body) {
  if (!isConfigured(company)) {
    // Demo mode: no credentials yet — message is stored locally only
    return { demo: true, id: 'demo-' + Date.now() };
  }
  const res = await fetch(`${GRAPH}/${company.wa_phone_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${company.wa_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone.replace(/[^\d]/g, ''),
      type: 'text',
      text: { body },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || 'WhatsApp API error';
    const err = new Error(msg);
    err.details = data;
    throw err;
  }
  return { demo: false, id: data.messages?.[0]?.id };
}

// Send an approved template message (required to start conversations)
async function sendTemplate(company, toPhone, templateName, lang = 'en') {
  if (!isConfigured(company)) {
    return { demo: true, id: 'demo-' + Date.now() };
  }
  const res = await fetch(`${GRAPH}/${company.wa_phone_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${company.wa_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone.replace(/[^\d]/g, ''),
      type: 'template',
      template: { name: templateName, language: { code: lang } },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'WhatsApp API error');
    err.details = data;
    throw err;
  }
  return { demo: false, id: data.messages?.[0]?.id };
}

module.exports = { isConfigured, sendText, sendTemplate };
