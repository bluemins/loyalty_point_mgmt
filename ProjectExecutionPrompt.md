# Prompts to give Claude Code, one phase at a time

Paste one prompt, review the plan, approve, test, commit, then move on. Do not paste several at once.

## Phase 0: plan only (use plan mode)
Read CLAUDE.md and /design/loyalty-screens.html. Do not write code yet. Propose: the folder structure, the full Postgres schema (tables, columns, indexes, tenant_id handling), the API route list, and the order you will build things. List any questions or risks.

## Phase 1: foundation
Set up the Express project, Postgres connection, migrations, and Redis connection. Create the tables from the approved schema plus a seed script that creates one demo tenant with settings and three rewards. Add env var validation on startup and a `.env.example`. Show me how to run it locally.

## Phase 2: OTP and sessions
Build the MSG91 OTP integration exactly as specified in CLAUDE.md's "OTP and security" section: send via `POST https://control.msg91.com/api/v5/otp` and verify via `GET https://control.msg91.com/api/v5/otp/verify`, using `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, and `MSG91_TEMPLATE_ID` as the default env vars, with a tenant-level override for `msg91_sender_id` and `msg91_template_id` in settings. Add a mock mode that activates automatically when `MSG91_AUTH_KEY` is unset (fixed OTP `000000`, no real HTTP call), for local dev and tests. Add rate limits on send (per phone and per IP), a 5-attempt verify limit, 5-minute OTP expiry, E.164 phone normalisation (+91 default), and signed httpOnly session cookies. Write tests for the rate limits, attempt limit, expiry, and for both the mock and tenant-override paths.

## Phase 3: scan flow
Build `/t/:slug/scan`. Implement anonymous pending points via device-token cookie, cooldown and daily cap from tenant settings, and merging pending points after OTP (new user creates a profile, existing user just merges). Tests for cap, cooldown, and merge.

## Phase 4: ledger and expiry
Build the append-only ledger, balance calculation, per-credit expiry, and the nightly expiry job. Add an endpoint for balance, expiring points, and activity. Tests for balance and expiry.

## Phase 5: rewards and redemption
Build the rewards catalog endpoints and atomic voucher redemption with FIFO deduction, idempotency key, and voucher code generation. Add redemption statuses and refund on cancel. Tests for double-spend prevention and FIFO.

## Phase 6: user interface
Build the mobile screens (landing, OTP, profile, points home, rewards, voucher issued), matching /design/loyalty-screens.html. Theme everything from tenant config via CSS variables. Test with at least two different tenant themes.

## Phase 7: admin panel
Build the admin login and pages: users, ledger, redemptions (fulfil or cancel), settings editor, reward catalog editor. Enforce roles: super_admin sees all tenants, tenant_admin sees only their own. Add a tenant isolation test.

## Phase 8: harden and deploy
Review the whole project for security and tenant isolation, add logging and error handling, write a README with setup steps, and prepare the Railway deployment (env vars list, Postgres and Redis services, cron for the expiry job).

## Useful follow-ups anytime
- "Add this decision to CLAUDE.md: ..." (whenever we decide something new)
- "Before changing anything, explain what you found and propose a fix."
- "Run the tests and show me what failed."