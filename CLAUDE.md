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

## Scan rules (all configurable per tenant in `settings`)
- The QR is shared, not unique, so abuse control is on the server.
- `points_per_scan` = 10
- `scan_cooldown_minutes` = 10
- `daily_scan_cap` = 5 credited scans per verified phone per day (day resets at midnight IST). Same cap per device token for anonymous scans.
- Over the cap or inside the cooldown: log the scan, credit nothing, show a friendly message.
- Setting changes apply to future scans only.

## Points ledger
- Append-only `ledger` table. Row types: `scan`, `redeem`, `expire`, `adjust`, `refund`.
- Balance = sum of unexpired credits minus debits. Never store a mutable balance as the source of truth.
- Each credit has `expires_at` = created + `points_expiry_days` (default 60).
- Redemptions consume the oldest unexpired credits first (FIFO).
- A nightly job writes `expire` rows for lapsed points.
- Redemption must be atomic: one DB transaction, lock the user's rows, and use an idempotency key so a double tap cannot spend twice.

## Rewards
- `rewards` catalog table: type (`voucher` or `product`), name, image, `points_cost`, stock, active, tenant_id.
- Vouchers are one reward type. Start with vouchers only, but keep the schema catalog-ready. The rewards screen may later become an e-commerce-style product grid.
- `redemptions` table with status: `issued`, `fulfilled`, `cancelled`. Cancelled redemptions write a `refund` ledger row.
- Voucher code is generated on redeem, with validity `voucher_validity_days` (default 30).

## OTP and security
- MSG91 auth key and template IDs come from env vars (per tenant where needed). Never expose them to the browser.
- Rate-limit OTP sends per phone and per IP. Limit verify attempts to 5 per OTP. OTP expires in 5 minutes.
- Validate and normalise phone numbers to E.164 (+91 default).
- Signed, httpOnly session cookies. Separate login for admins.
- Log admin actions (adjustments, cancellations).

## UI direction
- Very attractive, mobile-first. Reference mockup is in `/design/loyalty-screens.html`. Match its look: gradient hero, animated points ring, rounded cards, image-rich reward cards.
- Theming: every color comes from CSS variables set from the tenant config (`--b1`, `--b2`, `--soft`). No hardcoded brand colors.
- Screens: scan landing, OTP, new-user profile, points home, rewards catalog, voucher issued.
- Admin: users list, ledger view, redemptions (mark fulfilled or cancel), settings editor, reward catalog editor.

## Testing
- Automated tests for: daily cap, cooldown, FIFO redemption, expiry, double-spend prevention, tenant isolation (tenant A can never read tenant B).
- Mock OTP mode for tests.

## Out of scope for now
Native apps, payment gateway, custom domains, product delivery logistics.
