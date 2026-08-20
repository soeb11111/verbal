# Deploying to Railway

Railway runs the app as a normal always-on server, so broadcasts are not cut off by a
function timeout the way they are on Vercel. Expect roughly **$5–8/month** including the
database.

Total time: about 15 minutes.

---

## Step 1 — Put the code on GitHub

Railway deploys from a repository. If you don't have one yet:

1. Create an empty repo at https://github.com/new (private is fine) — e.g. `whatsapp-crm`.
2. Unzip the project, then from inside the folder:

```bash
git init
git add .
git commit -m "WhatsApp CRM"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/whatsapp-crm.git
git push -u origin main
```

`.gitignore` already excludes `node_modules` and `.env`, so no secrets are committed.

---

## Step 2 — Create the Railway project

1. Sign in at https://railway.app (GitHub login is easiest).
2. **New Project → Deploy from GitHub repo** → pick your repo.
3. Railway detects Node automatically and starts the first build. It will fail the health
   check for now — that's expected until the database and variables exist.

---

## Step 3 — Add the database

1. In the same project: **New → Database → Add PostgreSQL**.
2. Railway creates a Postgres service and a `DATABASE_URL` variable on it.

---

## Step 4 — Set the environment variables

Open your **app service** (not the database) → **Variables** → add:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `JWT_SECRET` | a long random string (see below) |
| `SUPER_ADMIN_EMAIL` | your email — this account gets the platform dashboard |

`${{Postgres.DATABASE_URL}}` is Railway's reference syntax — type it exactly as written and
Railway substitutes the real connection string. If your Postgres service has a different
name, use that name instead of `Postgres`.

Generate the secret locally:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Do **not** set `PORT` — Railway sets it for you and the app reads it.

Saving variables triggers a redeploy. The health check at `/api/health` should now pass.

---

## Step 5 — Get your public URL

App service → **Settings → Networking → Generate Domain**.

You get something like `whatsapp-crm-production.up.railway.app`. To use your own domain,
add it here and create the CNAME record Railway shows you.

---

## Step 6 — Create your platform owner account

Open the URL → **Create company account** → register with the same email you set as
`SUPER_ADMIN_EMAIL`.

Tables are created automatically on the first request. You'll land on **Platform → Clients**.

---

## Step 7 — Point WhatsApp at the new address

If you already configured Meta against the old Vercel URL, update it:

Meta app → **WhatsApp → Configuration → Edit webhook** → Callback URL:

```
https://YOUR-RAILWAY-DOMAIN/webhook/<companyId>
```

The exact URL for each workspace is shown on that workspace's **Settings** page. The verify
token stays whatever you set in the CRM.

---

## Moving existing data from Vercel/Neon

If you already created clients on the Vercel deployment and want to keep them, don't add a
Railway Postgres service — point Railway's `DATABASE_URL` at your existing Neon string
instead. The data comes with it and nothing needs migrating.

To copy between databases instead:

```bash
pg_dump "OLD_DATABASE_URL" > backup.sql
psql "NEW_DATABASE_URL" < backup.sql
```

---

## After it's live

- **Deploys**: every `git push` to `main` redeploys automatically.
- **Logs**: app service → Deployments → View Logs. Errors from WhatsApp sends and webhooks appear here.
- **Backups**: Postgres service → Backups. Turn these on before you take a paying client.
- **Spend cap**: Railway's Pro plan lets you set a hard monthly limit so a runaway bill can't happen.

## Troubleshooting

**Health check failing / "Setup required" page**
`DATABASE_URL` or `JWT_SECRET` is missing. The page lists exactly which. Add it and redeploy.

**`self signed certificate` or SSL errors**
Set `PGSSL=disable` if you're using Railway's private `*.railway.internal` host, or
`PGSSL=require` for an external database. The app auto-detects both, so this is only a fallback.

**Build succeeds but the site 502s**
Check the logs for a startup crash — usually a bad `DATABASE_URL`. The app refuses to start
serving until it can reach Postgres.

**Vercel deployment still running**
It's harmless, but delete or pause the Vercel project once Railway is live so clients can't
reach a stale copy pointing at a different database.
