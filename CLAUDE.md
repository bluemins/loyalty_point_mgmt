# Project: Multi-tenant QR loyalty platform

A white-label loyalty system sold to multiple clients. End users (carpenters, contractors, end-users) scan a shared QR code, verify their phone with OTP, earn points, and redeem rewards. First client's product category: plywood.

## How to work
- Before each phase: read this file, then propose a short plan and wait for approval. Do not write code in the planning step.
- Build only what the current phase asks. No extra features, no speculative abstractions.
- Ask when something is ambiguous instead of guessing.
- After each phase: tell me how to run it and test it. Commit with a clear message.
- Never put secrets in the repo. Every configurable value comes from environment variables or the `settings` table.
- Keep code simple and readable; comment only where the reason is not obvious.

## Stack
- Node.js + Express, hosted on Railway
- Postgres (system of record) and Redis (rate limits, cooldown and daily-cap counters, short-lived device tokens)
- OTP via MSG91 REST API (send and verify endpoints). Provide a mock mode for local dev with a fixed OTP.
- Frontend: mobile-first HTML, CSS and vanilla JS served by Express. No build step.
- Structure: modular by feature (`routes/`, `services/`, `db/`, `public/`). [Change this line if you want a single-file backend.]

## Multi-tenancy (critical)
- One deployment, one database. Every table has `tenant_id`. No query may run without it.
- All data access goes through one data-access layer that enforces `tenant_id` (or use Postgres row-level security).
- A user is unique on (`tenant_id`, `phone`). The same phone in two tenants means two separate accounts.
- Tenant is resolved from the QR URL slug, for example `/t/:slug/scan`. Custom domains come later.
- Tenant-owned queries go through `tenantQuery` in `src/db/tenantDb.js` (tenant id always bound as `$1`).
- Every Redis key contains the tenant id (e.g. `sess:<tenant_id>:<id>`, `scan:cd:<tenant_id>:...`), so all of a tenant's keys match `*:<tenant_id>:*`.
- User cookies (`sid` session, `dt` device) are scoped to path `/t/<slug>`, so each tenant has its own.
- Per-tenant config: brand name, logo, colors, tagline, user categories, points rules, reward catalog, MSG91 sender and template IDs.
- Roles: `super_admin` (me) and `tenant_admin` (sees only their tenant).
- Design so a specific client can later get a dedicated instance.

## Core flow
1. Anyone scans the shared QR, which opens the landing page. No login needed.
2. Anonymous scan: log it and hold pending points against a device-token cookie. Show "+N points pending, verify your phone to claim".
3. User enters phone, receives OTP, verifies.
4. New phone: create profile (name, category chosen from the tenant's list), credit pending points.
5. Existing phone: log in, merge pending points, show total balance, expiring points, activity, and redeem option.
6. Return visits on the same device use a signed session cookie, so no OTP is needed each time.

Decided:
- `GET /t/:slug/scan` only serves the landing page; the page's JS calls `POST /t/:slug/scan` to record the scan. Link previews, scanner apps and prefetch must never count as scans.
- After OTP verify, a new phone gets `needs_profile: true`; `POST /t/:slug/profile` creates the user and merges pending points. An existing phone merges at verify.
- Unclaimed pending points expire after `pending_points_ttl_days` (default 30).

## Scan rules (all configurable per tenant in `settings`)
- The QR is shared, not unique, so abuse control is on the server.
- `points_per_scan` = 10
- `scan_cooldown_minutes` = 10
- `daily_scan_cap` = 5 credited scans per verified phone per day (day resets at midnight IST). Same cap per device token for anonymous scans.
- Over the cap or inside the cooldown: log the scan, credit nothing, show a friendly message.
- Setting changes apply to future scans only.
- Cooldown: only a scan that earns points (credited or pending) starts it; refused scans do not restart the timer. `0` disables it.
- A logged-in scan also honours the device's cooldown, so "scan anonymously, log in, scan again" cannot earn twice in one window.
- Merging pending points applies the daily cap per IST scan day, counting what the phone already earned that day, so scanning on several devices cannot bypass the cap. Excess scans are logged as `capped`. Merge is one transaction with row locks, so scans are claimed once.
- Every scan is logged in `scan_events` with outcome `credited`, `pending`, `cooldown` or `capped`.

## Points ledger
- Append-only `ledger` table. Row types: `scan`, `redeem`, `expire`, `adjust`, `refund`.
- Balance = sum of unexpired credits minus debits. Never store a mutable balance as the source of truth. (`ledger.balance_after` was dropped for this reason; do not re-add a running balance.)
- Each credit has `expires_at` = created + `points_expiry_days` (default 60).
- Redemptions consume the oldest unexpired credits first (FIFO).
- A nightly job writes `expire` rows for lapsed points.
  - `npm run expire` (`src/jobs/expirePoints.js`), scheduled for 00:30 IST in production. Safe to re-run.
  - Lapsed credits leave the balance at their `expires_at`, even before the job runs; the job only records it in the ledger.
- Every debit row (redeem, expire, negative adjust) sets `consumes_ledger_id` to the one credit it draws from; a debit spanning several credits is several rows sharing `reference_type`/`reference_id`. Remaining of a credit = its amount + the debits pointing at it.
- Enforced in the DB: a trigger rejects direct UPDATE/DELETE on `ledger` (cascades from deleting a tenant or user are allowed); a check requires credits to have `expires_at` and debits to have `consumes_ledger_id`; a credit can be expired only once.
- `GET /t/:slug/points` returns balance, points expiring within `expiring_soon_days` (default 7) grouped by IST date, and the latest 50 activity entries (split debits grouped back into one event).
- Redemption must be atomic: one DB transaction, lock the user's rows, and use an idempotency key so a double tap cannot spend twice.

## Rewards
- `rewards` catalog table: type (`voucher` or `product`), name, image, `points_cost`, stock, active, tenant_id.
- Vouchers are one reward type. Start with vouchers only, but keep the schema catalog-ready. The rewards screen may later become an e-commerce-style product grid.
- `redemptions` table with status: `issued`, `fulfilled`, `cancelled`. Cancelled redemptions write a `refund` ledger row.
- Voucher code is generated on redeem, with validity `voucher_validity_days` (default 30).

Decided:
- `GET /t/:slug/rewards` is public (active rewards, `in_stock` flag, no stock counts). `POST /t/:slug/rewards/:id/redeem` needs a logged-in user with a profile and an `Idempotency-Key` header. `GET /t/:slug/redemptions` lists the user's own vouchers.
- Redemption transaction: lock the user row (the same lock merge and the expiry job take), check the idempotency key, lock the reward row, spend credits oldest created first, write one `redeem` row per credit used, decrement stock.
- Same key + same user + same reward returns the original result (`replayed: true`). Same key from another user or for another reward is a 409.
- Voucher codes: `XXXX-XXXX-XX` from an alphabet without 0/O/1/I, unique per tenant.
- Only `issued` can be fulfilled or cancelled; `fulfilled` is final (reverse with a manual `adjust` instead). Cancel writes one `refund` credit with a fresh `points_expiry_days` expiry (cancel is admin-only, so this cannot be used to extend points) and restores stock.
- Vouchers past `voucher_expires_at` are `expired`: final, no refund (goodwill goes through an admin `adjust`). They read as expired at once; the nightly `npm run expire` also sets `status = 'expired'`.
- `tenants.brand_name`, `tenants.tagline` and `tenants.colors` are kept for later use but not read; `settings` is the source of truth.

## Admin panel (decided)
- `/admin` (page) and `/admin/api` (JSON). Admins are created only with `npm run admin:create` (scrypt password hashes, lowercase emails). No UI for admins or tenants yet.
- Brands are created with `npm run tenant:create` (`src/services/tenantSetup.js`): slug (2-40, lowercase, single hyphens), brand name and categories (validated with `SETTINGS_SCHEMA`), optionally the first tenant_admin, all in one transaction. Only `brand_name` and `user_categories` rows are written; everything else uses the defaults.
- Admin identity is global, so `admin_users` lookups are the one place that queries without `tenant_id`; admin Redis keys live under `adm:` (not tenant-scoped).
- Session: Redis, `ADMIN_SESSION_TTL_HOURS` (12), cookie `asid` signed, httpOnly, `SameSite=Strict`, path `/admin`. The admin row is re-read on every request. Non-GET requests must be JSON (with SameSite=Strict, blocks cross-site forms).
- Lockout: `ADMIN_LOGIN_MAX_FAILURES` (5) per email per `ADMIN_LOGIN_WINDOW_MINUTES` (15), `ADMIN_LOGIN_MAX_FAILURES_PER_IP` (20) per hour. Same error for unknown email and wrong password.
- Every tenant route is `/admin/api/t/:slug/...`; a tenant_admin gets 404 for any other tenant (as if it did not exist). `tests/admin.test.js` fails if a route is added without being in its isolation list.
- `otp_*` and `msg91_*` settings are super_admin only (they control SMS spend on the platform's MSG91 account).
- Settings are validated per key (`SETTINGS_SCHEMA` in `src/services/adminData.js`); unknown keys are rejected. The editor shows effective values (the same defaults the app uses) and saves only changed keys.
- Every admin change writes `admin_action_log` in the same transaction (before/after values, reasons). Deleting an admin cannot erase their log (FK is NO ACTION).
- Point adjustments need a reason; adding points is a fresh credit, removing points takes oldest credits first and cannot go below zero.

## OTP and security
- MSG91 auth key and template IDs come from env vars (per tenant where needed). Never expose them to the browser.
- Rate-limit OTP sends per phone and per IP. Limit verify attempts to 5 per OTP. OTP expires in 5 minutes.
  - Defaults, per tenant in `settings`: 3 sends per phone per 15 minutes (`otp_send_limit_per_phone`, `otp_send_window_phone_minutes`), 10 per IP per hour (`otp_send_limit_per_ip`, `otp_send_window_ip_minutes`).
- MSG91 generates and verifies the OTP itself; we never see it. Expiry and the attempt limit are still enforced on our side (Redis) so mock and real mode behave the same. Mock mode is on whenever `MSG91_AUTH_KEY` is empty.
- Tenant `settings` values `msg91_sender_id` / `msg91_template_id` override the env defaults. `npm run seed` copies the env values into the demo tenant, so re-seed after changing them in `.env`.
- Indian SMS requires DLT: the sender ID needs the Entity ID and the template needs the DLT Template ID in the MSG91 dashboard. Not done yet, so real delivery is unverified.
- Validate and normalise phone numbers to E.164 (+91 default).
- Signed, httpOnly session cookies. Separate login for admins.
- User sessions are stored in Redis (`SESSION_TTL_DAYS`, default 30); the cookie carries only a random signed id, so logout and bans take effect immediately.
- Behind Railway's proxy, `trust proxy` is on in production only, so local clients cannot spoof their IP for rate limits.
- Log admin actions (adjustments, cancellations).

## UI direction
- Very attractive, mobile-first. Reference mockup is in `/design/loyalty-screens.html`. Match its look: gradient hero, animated points ring, rounded cards, image-rich reward cards.
- Theming: every color comes from CSS variables set from the tenant config (`--b1`, `--b2`, `--soft`). No hardcoded brand colors.
- Screens: scan landing, OTP, new-user profile, points home, rewards catalog, voucher issued.
- Admin: users list, ledger view, redemptions (mark fulfilled or cancel), settings editor, reward catalog editor.

Decided:
- The mockup file was never provided; the UI follows this brief. First client palette (from their wood photos): walnut `#4A2412`, teak amber `#C8742B`, pine cream `#FBF3E6`, with a CSS-drawn wood grain on the hero (`hero_texture` = `wood` | `none`). No photos are shipped (licence unknown).
- One page (`src/views/app.html`, `public/app.js`, `public/app.css`) with hash screens. `GET /t/:slug/scan` and `GET /t/:slug/` render it with the tenant's brand, tagline and logo; `GET /t/:slug/config` is the public config.
- Colours are served by `GET /t/:slug/theme.css` (`Cache-Control: no-cache` + ETag), not inlined, so the page has no inline styles or scripts (ready for a strict CSP; a test enforces it). After a scan the page replaces its URL with `/t/<slug>/`, so reloading does not scan again; only opening `/scan` does.
- Tenant values are validated before reaching the page (hex colours only, known textures, http(s) or root-relative `logo_url`) and HTML-escaped. The client inserts data with `textContent` only.
- Neutral text and shadow colours are derived from `--b1` via `color-mix`, so no theme looks tinted by another.
- `demo-laminates` (teal) is seeded next to `demo` so two themes are always available.
- `npm run test:e2e` (Playwright, dev-only) runs the full journey in two themes and writes screenshots to `screenshots/` (gitignored).
- `npm run test:demo` (`tests/e2e/demo.e2e.js`) follows the brand admin presentation step by step; `HEADED=1` opens the browsers to watch it. Keep it in step with `docs/DEMO_SCRIPT.md` and the slide deck. In WSL, Chromium needs `sudo env "PATH=$PATH" npx playwright install-deps chromium` once.

## Testing
- Automated tests for: daily cap, cooldown, FIFO redemption, expiry, double-spend prevention, tenant isolation (tenant A can never read tenant B).
- Mock OTP mode for tests. Tests force mock mode via `app.locals.msg91` even if `.env` has a real key; they must never send SMS.
- Tests create their own tenants (`tests/helpers.js`) and never touch the demo tenant. Teardown asserts no rows and no Redis keys are left behind.
- Assert exact counts, not `>= N`. Scripts meant to be re-run (seed, migrate) get a run-twice test.
- After any run, check the actual Postgres and Redis state, not only the API responses.

## Current state and docs
- Phases 1–7 are done. Phase 8: review done; `tenant:create` and `theme.css` done; the other fixes and deployment not started. Details: `docs/STATUS.md`.
- **Open security findings (fix before any production deploy):** mock OTP is active in production when `MSG91_AUTH_KEY` is empty (`000000` logs in anyone); no per-IP limit on new anonymous scan devices; no security headers; malformed JSON returns 500; `/health` returns 200 when degraded; Postgres SSL hard-coded. Full list in `docs/STATUS.md`.
- Docs in `docs/`: `API.md` (every endpoint), `USER_GUIDE.md` (end users), `ADMIN_GUIDE.md` (admins, points maths, corner cases), `ACCOUNTS.md` (creating users, brands, admins), `STATUS.md`, `TEST_CHECKLIST.md` (manual acceptance test for the super admin), `DEMO_SCRIPT.md` (live demo for a brand admin, used with the slide deck "Loyalty Programme: Admin Walkthrough" on claude.ai). Screenshots in `docs/images/`.
- When behaviour, an endpoint or a default changes, update the matching doc in the same commit.

## Local dev
- Run in WSL with the Linux Node from nvm (`. ~/.nvm/nvm.sh`), not the Windows Node on `/mnt/c`.
- `npm run migrate`, `npm run seed` (both safe to re-run), `npm run dev`, `npm test`.
- Restart `npm run dev` after editing `.env`; `--watch` does not reload it.

## Out of scope for now
Native apps, payment gateway, custom domains, product delivery logistics.
