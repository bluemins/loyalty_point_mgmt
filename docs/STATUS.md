# Project status

As of 2026-09-27. Phases follow `ProjectExecutionPrompt.md`.

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation: Express, Postgres, Redis, schema, seed, env validation | ✅ Done |
| 2 | OTP (MSG91 + mock) and sessions | ✅ Done; real SMS not yet verified |
| 3 | Scan flow, pending points, cooldown, daily cap, merge | ✅ Done |
| 4 | Ledger, balance, per-credit expiry, nightly job, points endpoint | ✅ Done |
| 5 | Rewards, atomic redemption, vouchers, cancel/fulfil | ✅ Done |
| 6 | User app screens, per-tenant theming | ✅ Done |
| 7 | Admin panel, roles, tenant isolation, audit log | ✅ Done |
| 8 | Security review, logging, README, Railway deployment | 🟡 Review done; fixes and deployment **not started** (plan awaiting approval) |

## Done

### Implementation
- **Multi-tenancy.** Tenant from the URL slug. Every tenant query goes through `tenantQuery`, and every Redis key includes the tenant id. User cookies are scoped to `/t/<slug>`.
- **Login.** Phone OTP via MSG91, with a mock mode.
  - Send limits per phone and per IP, 5 verify attempts, 5-minute expiry.
  - Sessions in Redis (30 days).
- **Scanning.**
  - Anonymous pending points on a device cookie, a 10-minute cooldown (also enforced across login on the same device), and 5 scans a day (IST).
  - Pending points merge at verify/profile, capped per scan day and claimable once.
- **Ledger.**
  - Append-only (enforced by a database trigger); every debit is linked to the credit it draws from.
  - Balance is always calculated; each credit has its own expiry.
  - Nightly job (`npm run expire`) for points and vouchers.
- **Rewards.**
  - Public catalog; redemption in one transaction with an idempotency key, oldest credits first, and stock control.
  - Voucher codes; fulfil/cancel (refund as a fresh credit); vouchers expire after 30 days with no refund.
- **User app.** 6 screens with animated points ring; theme from tenant settings (validated and escaped); wood texture option; two seeded demo themes.
- **Admin panel.**
  - Login with scrypt and lockout; `tenant_admin` / `super_admin`.
  - Screens: users with balances, point adjustments, ledger, redemptions (fulfil/cancel), validated settings, rewards.
  - Audit log written in the same transaction as each change. OTP/MSG91 settings are super-admin only.
- **Command:** `npm run admin:create`.
- **Docs:** [API.md](API.md), [USER_GUIDE.md](USER_GUIDE.md), [ADMIN_GUIDE.md](ADMIN_GUIDE.md), [ACCOUNTS.md](ACCOUNTS.md).

### Testing
- **95 automated tests** (`npm test`) against real Postgres and Redis:
  - OTP: limits, attempts, expiry, mock and real paths
  - sessions: tamper, cross-tenant, logout
  - scanning: cooldown, cap, IST midnight, merge rules
  - points: balance, expiry job (exact, idempotent, concurrent, per tenant), append-only trigger
  - redemption: oldest-first spending, double-tap and concurrent overspend, last-unit race, cancel/fulfil, voucher expiry
  - pages: theming and escaping
  - admin: auth, lockout, settings validation, adjustments, audit rows
  - **tenant isolation for every admin route** (a guard test fails if a new route is not covered)
  - seed run twice; test cleanup verified
- **4 browser tests** (`npm run test:e2e`, Playwright Chromium): the full user journey in two themes, and the admin journey (tenant admin + super admin), with screenshots.
- Key guards were **mutation-checked**: each was deliberately broken to confirm a test fails.

## Pending: implementation

### Security fixes found in the Phase 8 review (fix before production)

| # | Issue | Severity |
|---|---|---|
| 1 | With `NODE_ENV=production` and no `MSG91_AUTH_KEY`, mock mode is active: **`000000` logs in to any phone number** | 🔴 Critical |
| 2 | No per-IP limit on new anonymous devices: a script can create unlimited pending scans | 🟠 High |
| 3 | No security headers (CSP, frame protection, HSTS); `X-Powered-By` exposed | 🟠 High |
| 4 | Malformed JSON returns 500 (should be 400) and logs a stack trace | 🟡 Medium |
| 5 | Unknown routes return Express's HTML page, also for API calls | 🟡 Low |
| 6 | No structured request logs, request ids or graceful shutdown on redeploy | 🟡 Medium |
| 7 | `/health` returns 200 when the database or Redis is down | 🟡 Medium |
| 8 | Postgres SSL hard-coded on in production (may not match Railway's private network) | 🟡 Medium |
| 9 | User-app POSTs accept any content type (the admin API requires JSON) | 🟢 Low |

### Rest of Phase 8
- README with setup steps and an environment variable table.
- Railway: web service config (migrate before deploy, health check), cron service for `npm run expire` at 00:30 IST (`0 19 * * *` UTC), Node version pin.
- `npm run tenant:create` (proposed; today brands are created with SQL).

### Smaller gaps
- **Admin accounts:** no password reset, deactivate or "manage admins" screen (manual steps in [ACCOUNTS.md](ACCOUNTS.md)).
- **Audit log:** recorded, but no screen to view it.
- **Users:** cannot be deleted or have their phone number changed.
- **Rewards:** only vouchers; `product` type and image upload not built (image by URL only).
- **Copy:** the "scanned recently" screen repeats the same sentence in the title and the message.
- **Unused schema:**
  - The `device_tokens` table is unused (device hashes live on `scan_events`).
  - `tenants.brand_name`, `tagline` and `colors` are kept for later but not read.
- **Out of scope** (per CLAUDE.md): native apps, payments, custom domains, delivery logistics.

## Pending: testing

| Area | State |
|---|---|
| **Real MSG91 SMS** | MSG91 accepts our requests, but no SMS has been delivered: DLT Entity ID and Template ID not yet linked for the sender. Needs one real send + verify once DLT is done. |
| **Railway deployment** | Not deployed yet. |
| **Screens not covered by browser tests** | Checked by screenshots only, not by automated tests: log out, resend code, error messages (network failure, OTP rate limit), the copy-code fallback on plain http. The cooldown and daily-limit screens were captured for the docs, but no test asserts them. |
| **Browsers and devices** | Automated tests use Chromium only. Not yet checked on real Android/iOS phones, Safari or Firefox. |
| **Load** | No load or performance testing. |
| **Accessibility** | Basic labels and reduced-motion support; no formal audit. |
