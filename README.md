# Verbal — Multi-tenant WhatsApp Business CRM

A hosted, multi-tenant WhatsApp CRM. One deployment serves many client companies,
each in a fully isolated workspace (own users, contacts, conversations, campaigns,
chatbots and WhatsApp number). A single **platform owner** creates client accounts,
sets plan limits, suspends for non-payment, and can enter any workspace for support.

Stack: **Node.js + Express 5 + PostgreSQL** (raw SQL, no ORM) and a **single
vanilla-JS front-end** (`public/index.html`). No React, no build step.

## Project layout
```
server.js          Express app + all routes (entry point)
db.js              Schema (idempotent), plan presets, query helpers
whatsapp.js        Meta WhatsApp Cloud API client
public/index.html  The ENTIRE front-end (single file)
test.js            API test suite (PGlite, no external DB)
uitest.js          UI test suite (jsdom)
.env.example       Environment variable template
```

## Requirements
- Node.js 18+ (works on 20)
- A PostgreSQL database (managed + persistent recommended for production)

## Environment variables (copy `.env.example` to `.env`)
| Var | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL` | yes | Postgres connection string |
| `JWT_SECRET` | yes (prod) | 32+ chars; random per-process in dev if unset |
| `SUPER_ADMIN_EMAIL` | yes | The platform-owner email (e.g. sohaibak5@gmail.com) |
| `NODE_ENV` | prod | `production` when hosted |
| `PORT` | no | Defaults to 3000; hosts usually set this |
| `PGSSL` | no | `require` or `disable` to override SSL auto-detect |
| `PG_POOL_MAX` | no | Connection pool size |
| `SMTP_HOST/PORT/USER/PASS/FROM/SECURE` | no | Set to send real password-reset emails; otherwise demo delivery (link logged/returned) |

The schema is created automatically on first request (`CREATE TABLE IF NOT EXISTS`),
so there is no separate migration step and deploys never destroy data.

## Run locally
```bash
npm install
cp .env.example .env      # fill in DATABASE_URL, JWT_SECRET (32+), SUPER_ADMIN_EMAIL
node server.js            # http://localhost:3000
```
On first run the login screen opens on the Sign-up tab — create your platform-owner
account using the email set in `SUPER_ADMIN_EMAIL`.

## Test (no external database needed)
```bash
npm test         # API suite (30 tests) via PGlite
npm run uitest   # UI suite (7 tests) via jsdom
```

## Deploy
Use an **always-on Node host** (Railway, Render, Fly.io, or a VPS). Do **not** use
serverless (function timeouts break large broadcasts).
- Provision a **separate, persistent PostgreSQL** service and set `DATABASE_URL`.
- Set `JWT_SECRET` (32+ chars), `SUPER_ADMIN_EMAIL`, `NODE_ENV=production`.
- Start command: `node server.js`
- Health check: `GET /api/health` (actually queries the DB).
- **Enable automatic database backups before onboarding paying clients.**

## WhatsApp (per client, in Settings)
By default the app runs in **demo mode** (messages stored, not sent). A client goes
live by entering their Meta Cloud API access token, phone number ID and a webhook
verify token, then pasting their per-workspace webhook URL (`/webhook/:companyId`)
into Meta WhatsApp Manager.

## Roles & plans
- Roles: `owner` (one per company), `admin`, `agent`.
- Plans: trial (3u/500c), starter (5u/2000c), pro (20u/25000c), business (100u/250000c).
- Modules: inbox, contacts, broadcast, templates, automation (gated per plan).
