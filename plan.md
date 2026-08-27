# plan.md — Verbal (Multi-tenant WhatsApp CRM) Development Plan

## 1) Objectives
- Deliver **Verbal v1** as a hosted, multi-tenant WhatsApp Business CRM (DoubleTick-like UX; Verbal teal palette).
- Enforce **strict tenant isolation**, **role-based access**, **plan limits/modules**, and **platform owner** controls (create/suspend/impersonate/delete).
- Support **WhatsApp DEMO mode** end-to-end (store messages, statuses `demo`, simulate inbound, webhook handling), with real Meta Cloud API code path gated by per-company credentials.
- Provide a **single-file vanilla JS UI** (`public/index.html`) that covers all modules and states.
- Ship with **in-process PGlite test suites**: `test.js` (API) + `uitest.js` (jsdom UI), runnable via `npm test` and `npm run uitest`.

## 2) Implementation Steps

### Phase 1 — Core POC (isolation) (must be green before building full UI)
**Core = multi-tenant isolation + auth/roles + plan enforcement + demo WhatsApp message flow.**

User stories:
1. As the platform owner, I can create my owner account on first run using `SUPER_ADMIN_EMAIL`.
2. As the platform owner, I can create a client workspace and receive one-time credentials.
3. As an agent, I can only see contacts/messages within my workspace (no cross-tenant access).
4. As a user, I can send a message in demo mode and see it stored with status `demo`.
5. As an agent, I can simulate an inbound WhatsApp message that creates/updates a contact and reopens a resolved conversation.

Steps:
1. **Repo restructure to per-brief layout** (root files + `public/index.html` only).
2. Implement `db.js`:
   - Idempotent schema (tables + indexes) + plan presets + helper `query()`.
   - Enforce UTC timestamp string formatting on API responses.
3. Implement `server.js` minimal API POC:
   - `/api/health`, `/api/auth/config`, `/api/auth/register`, `/api/auth/login`, `/api/me`.
   - Auth middleware: JWT verify + reload user(active) + load company + suspension gate.
   - Tenant scoping enforced in every query.
4. Implement POC endpoints for core flow:
   - Contacts: create/list (scoped), enforce contact limit with inbound exception.
   - Messages: send/list for contact (demo mode write path).
   - Inbox counts: open/closed/unread/awaiting reply.
   - `POST /api/simulate-incoming` (creates contact if needed, message `in`, unread++, welcome bot).
5. Add platform owner primitives (POC scope):
   - `GET /api/admin/overview` (minimal) and `POST /api/admin/companies` (create workspace + owner user).
   - `POST /api/admin/companies/:id/impersonate` (issue client JWT).
6. Build `test.js` with PGlite (no external DB):
   - First-run owner register rules.
   - Login + forged token rejection + inactive/suspended blocking.
   - Tenant isolation both directions.
   - Role checks baseline (agent cannot hit admin endpoints).
   - Plan boundary 402 (contacts/users).
   - Simulate inbound → contact create + welcome bot reply.
7. Iterate until `npm test` is fully green.

### Phase 2 — V1 App Development (API + single-file UI)
User stories:
1. As an agent, I can work an Inbox with Open/Closed/Unread/Awaiting Reply filters and search.
2. As an agent, I can chat with a contact (incoming/outgoing/note bubbles), resolve/reopen, and see unread badges update.
3. As an admin, I can manage templates, launch a broadcast campaign to a segment, and see delivery stats.
4. As an admin, I can manage bot rules (welcome/keyword) and see run counts.
5. As a company owner/admin, I can manage team members within plan limits.

Steps:
1. Expand DB + API to full surface:
   - Team CRUD + owner protections + user limit enforcement.
   - Contacts table search/filter/pagination; status open/closed; stage/tags/owner.
   - Messages endpoint: send (demo vs real WA gated), notes, receipts update.
   - Quick replies CRUD + usage increment via `/api/quick-replies/:id` used flag.
   - Templates CRUD (approved flag, name normalization).
   - Campaigns create/list + launch validation + per-recipient result rows.
   - Bots CRUD with triggers + run counts; ensure bot replies don’t clear `last_direction`.
   - Stats for dashboard KPIs + pipeline chart data.
   - Settings endpoints for company profile + WA creds (token write-only) + plan usage.
   - Webhook GET verify + POST async processing (ack immediately).
2. Implement **module gating**:
   - Hide disabled modules in UI; enforce 403 in API.
3. Implement **platform owner** full features:
   - Admin overview table/cards; suspend/reactivate; edit plan/limits/modules/notes.
   - Reset owner password (show once), delete with exact-name confirm, over-limit flagging.
   - Impersonation with persistent banner and switch-back.
4. Build `public/index.html` (single file) with:
   - Layout: icon rail (hover expand), top bar with WA/demo pill, page scaffolds.
   - Client-side router (hash-based) for pages; centralized `apiFetch()` with auth.
   - Chats 5-column layout: filters, chat list (debounced search), conversation, details/notes.
   - Quick-reply picker “/” behavior + `{name}` substitution.
   - Empty/loading/error states, 402/403 messaging, suspended lock screen.
   - Demo mode indicator (top bar + dashboard banner) always visible when no WA creds.
5. Emergent preview adaptation:
   - Run Express on **8001** (serves `/api`, `/webhook`, and static `public/`).
   - Serve `public/index.html` on **3000** via lightweight static server.
   - Add supervisor entries for node server + static server + postgres resilience; disable default uvicorn/yarn.
6. End-to-end smoke run in browser; then run `npm test`.

### Phase 3 — Comprehensive Testing, UX hardening, and regressions
User stories:
1. As a platform owner, I can impersonate a workspace and safely switch back without losing my admin session.
2. As an admin, I can suspend a company and immediately block their active sessions.
3. As an agent, I can resolve a conversation and it auto-reopens when an inbound message arrives.
4. As an admin, I can launch a broadcast only when the segment is non-empty.
5. As a user, I never see another company’s data even if I tamper with IDs in URLs.

Steps:
1. Expand `test.js` coverage to full required list (impersonation, deletion confirm, awaiting-reply logic, webhook verify fail, etc.).
2. Implement `uitest.js` jsdom suite:
   - Load `public/index.html`, login, navigate pages, open chat, send message, resolve, use quick reply.
   - Fail on console errors/unhandled rejections.
3. Security & correctness pass:
   - Validate enums/inputs; protect destructive ops; never return password hashes/WA token.
   - Ensure timestamps and indexing.
4. Final polish: performance (debounce/search), UI alignment to reference interactions, consistent toasts/errors.

## 3) Next Actions
1. Create the per-brief file layout (`server.js`, `db.js`, `whatsapp.js`, `public/index.html`, `test.js`, `uitest.js`, `package.json`).
2. Implement Phase 1 POC endpoints + schema + PGlite tests and get `npm test` green.
3. Wire Emergent preview process model (node on 8001 + static on 3000 + postgres supervised).
4. Proceed to Phase 2 (full API + full single-file UI) only after POC is stable.

## 4) Success Criteria
- `npm test` passes (PGlite) and covers: auth, isolation, roles, plan limits, suspension, impersonation, resolve/reopen, quick replies, webhook verify + inbound creation + welcome bot.
- `npm run uitest` passes with zero console errors.
- Manual E2E: platform owner can create/suspend/impersonate/delete workspaces; client users can operate Inbox/Customers/Team/Templates/Broadcast/Bots/Settings per plan.
- Demo mode is unmistakable (UI indicator) and message sends are stored as `demo` with correct inbox state transitions.
- All APIs enforce company scoping and module gating; over-limit behavior returns 402 with readable message.
