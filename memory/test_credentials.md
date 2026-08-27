# Verbal — Test Credentials

## Platform owner (super admin)
- Email: sohaibak5@gmail.com  (matches SUPER_ADMIN_EMAIL)
- Password: verbal123  (set on first-run sign-up; change any time in the app)
- Gets the Platform section (Clients, Platform settings) + all /api/admin/* routes.

## Demo client workspace
- Company: Acme Retail (plan: pro)
- Owner: alice@acme.com  (password generated at creation — reset via Platform > Clients > ⋯ > Reset owner password)

## Notes
- WhatsApp is in DEMO MODE (no Meta credentials). Messages are stored with status 'demo'
  and never sent. Use the "Simulate incoming message" tool in Chats/Customers to test.
- Local dev DB: postgresql://verbal:verbal_pass@localhost:5432/verbal
- Runtime: supervisor programs `postgresql`, `verbal-api` (:8001 -> /api), `verbal-web` (:3000 -> UI + /webhook).
- Tests (no external DB, use PGlite/jsdom): `npm test` (24 API) and `npm run uitest` (6 UI).
