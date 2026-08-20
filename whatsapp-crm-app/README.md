# ChatDesk — WhatsApp Business CRM (multi-tenant, self-hosted)

Shared team inbox, contacts, broadcast campaigns, templates, auto-reply bots, user management with roles, and real WhatsApp send/receive via Meta's Cloud API. Each company gets an isolated workspace.

Data is stored in **PostgreSQL**, so it survives restarts and redeploys.

---

## Where to host it

**Railway is the recommended host** — see **[DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md)** for a
step-by-step guide (~15 minutes, ~$5–8/month including the database).

A word of warning about serverless hosts (Vercel, Netlify Functions, Cloudflare Workers):
functions there are capped at 10–60 seconds. Broadcast campaigns send messages in a loop, so
on Vercel a campaign is killed after roughly 20 contacts (Hobby) or 150 (Pro). Everything
else works fine there, but bulk messaging does not. Any always-on host — Railway, Render,
Fly.io, or a plain VPS — has no such limit.

The app is a standard Express + Postgres application with no host-specific code, so it runs
anywhere Node 18+ runs.

---

## Setup (15 minutes)

### 1. Create a free database

1. Sign up at **https://neon.tech** (free tier, no card).
2. Create a project → copy the **connection string** (starts with `postgresql://`).
3. Use the **pooled** connection string if offered — it ends with `-pooler...`. Serverless platforms need it.

Supabase, Railway Postgres, or any Postgres works too.

### 2. Set two environment variables

In Vercel: **Project → Settings → Environment Variables** (or a local `.env` file):

| Name | Value |
|---|---|
| `DATABASE_URL` | the connection string from step 1 |
| `JWT_SECRET` | a long random string (48+ chars) |
| `SUPER_ADMIN_EMAIL` | your email — this account gets the platform dashboard |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_SECRET` signs login tokens. If it leaks or is guessable, anyone can forge a login — treat it like a password and never commit it.

After adding variables on Vercel, **redeploy** so they take effect.

### 3. Open the app and create your account

Visit your URL → **Create company account** → register with the same email you set as `SUPER_ADMIN_EMAIL`. You become the platform owner and get the **Platform → Clients** dashboard.

Tables are created automatically on first request. Until `DATABASE_URL` and `JWT_SECRET` are set, the site shows a "Setup required" page listing what's missing.

---

## Running it as a business

**Public sign-up is closed by default.** Nobody can create their own workspace — you create each client from the admin panel. Two exceptions exist so you can never lock yourself out: the very first account on a fresh database, and anyone registering with the `SUPER_ADMIN_EMAIL` address.

### Platform → Clients

- **Create a client** — enter their company, owner name, email and a plan. You get a one-time credentials screen to send them.
- **Usage per client** — users, contacts, messages in the last 30 days, WhatsApp connection status, last activity. Clients at their limit show in red.
- **Edit plan** — switch plan (applies that plan's presets), or hand-tune max users, max contacts and which modules they see.
- **Suspend / reactivate** — a suspended client is locked out immediately, including sessions already logged in. Use this for non-payment.
- **Reset owner password** — generates a new password and shows it once. This is your stand-in until self-service password reset is built.
- **Open as client (👁️)** — logs you into their workspace as the owner for support or demos. A purple bar stays on screen until you switch back.
- **Delete** — removes the workspace and all its data. Requires typing the client name to confirm.

### Plans

| Plan | Users | Contacts | Modules |
|---|---|---|---|
| trial | 3 | 500 | all |
| starter | 5 | 2,000 | inbox, contacts, templates |
| pro | 20 | 25,000 | all |
| business | 100 | 250,000 | all |

Limits are enforced server-side when a client adds a user or contact — they get a clear upgrade message rather than a silent failure. Disabled modules are hidden in the client's sidebar *and* blocked at the API, so they can't be reached by URL.

Edit the `PLANS` object in `db.js` to change pricing tiers. Plan names are stored per client, so renaming a plan means updating existing clients too.

**One deliberate exception:** inbound WhatsApp messages from unknown numbers always create a contact, even if the client is over their contact limit. Losing a real customer message would be worse than exceeding a cap. Over-limit clients are flagged red in the Clients list so you can follow up.

---

## Running locally

Requires **Node.js 18+**.

```bash
npm install
# create .env with DATABASE_URL (and optionally JWT_SECRET)
npm start          # → http://localhost:3000
npm test           # 54 end-to-end tests, no database needed
```

Tests run against PGlite (Postgres compiled to WASM), so they need no setup and touch no real data.

---

## Using it

- **Team page** — add users as **Admin** (manage users, settings, campaigns) or **Agent** (inbox and contacts only). They log in at the same URL with the email and password you set. Deactivating or removing a user immediately kills their active session.
- **Team Inbox** — assign chats, add internal notes, tag contacts, set lead stages.
- **Simulator** — "🧪 Simulate incoming message" fakes a customer message so you can test the inbox and bots before connecting WhatsApp.
- **Automation** — welcome rule (first message from a new contact) and keyword rules.
- **Broadcast** — send an approved template to a segment (all contacts, a tag, or a lead stage).

Until WhatsApp is connected the app runs in **demo mode**: messages are stored in the CRM and marked `demo`, but nothing is sent to real phones.

---

## Connecting real WhatsApp (Meta Cloud API)

1. https://developers.facebook.com → **Create App** → type **Business**.
2. **Add product → WhatsApp → Set up**. You get a free test number immediately (can message up to 5 verified recipients).
3. From **WhatsApp → API Setup**, copy the **Phone number ID** and an **Access token**.
   - The quick-start token expires in 24 hours. For production create a permanent one: Business Settings → System Users → add a system user → generate token with `whatsapp_business_messaging` permission.
4. In the CRM → **Settings → WhatsApp connection**: paste the token and phone number ID, and invent a **verify token** (any secret word). Save.
5. Meta app → **WhatsApp → Configuration → Edit webhook**:
   - Callback URL: `https://YOUR-DOMAIN/webhook/<companyId>` (shown on your Settings page)
   - Verify token: the word you chose
   - Subscribe to the **messages** field.
6. Message your Meta number — it appears in the Team Inbox, and replies send for real.

**Templates:** to message customers outside the 24-hour reply window (all broadcasts), the template must be approved in **Meta WhatsApp Manager → Message templates**. Create it there, then add the same template name in the CRM and mark it Approved. Campaigns send by template name.

**Costs:** Meta charges per conversation; rates vary by country and by marketing vs utility category. The API itself is free.

---

## Architecture

```
public/index.html   Front-end (vanilla JS single page app)
server.js           Express API — auth, users/roles, contacts, inbox,
                    campaigns, templates, bots, per-company webhook
db.js               Postgres schema + query helpers
whatsapp.js         Meta Cloud API client
test.js             54 end-to-end tests
```

Every table carries `company_id` and every query is scoped to the logged-in user's company, so companies cannot see each other's data (covered by tests).

---

## Before selling this to clients

Working today: multi-tenant workspaces, authentication, roles, user management, inbox, contacts, campaigns, templates, bots, WhatsApp send/receive.

Still missing for a commercial product:

- **Password reset and email verification** — no way for a user to recover an account.
- **Rate limiting / brute-force protection** on the login endpoint.
- **Billing and subscriptions.**
- **Database backups** (Neon's paid tiers add point-in-time restore).
- **Encryption of stored Meta tokens** — they currently sit in plain text in the database.
- **Audit log** of who did what.
- **Terms of service and privacy policy**, plus GDPR/PDPL handling for stored customer chats.
- **Independent security review** before you take payment.
- **Meta's rules for resellers** — providing WhatsApp API access to other businesses may require registering as a Meta Tech Provider. Confirm your obligations before onboarding paying clients.
