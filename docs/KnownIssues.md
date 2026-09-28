# Known issues

As of 2026-09-27. Everything found in the code review, testing and demo rehearsals that is not fixed yet. No code has changed for this list. The status per phase is in [STATUS.md](STATUS.md).

**Priority**
- 🔴 Must fix before any production use
- 🟠 Fix before the first real client goes live
- 🟡 Should fix soon
- 🟢 Nice to have

---

## 1. Security

| # | Issue | Why it matters | Priority |
|---|---|---|---|
| S1 | **Test mode (mock OTP) switches on whenever `MSG91_AUTH_KEY` is empty, even in production.** | On a live server without the key, the code `000000` signs in to **any** phone number, and anyone can take over any customer's points. | 🔴 |
| S2 | **The example `SESSION_SECRET` in `.env.example` passes validation.** The only check is a minimum of 16 characters. | If someone copies the example into production, anyone who has read the repo can forge session and admin cookies. | 🔴 |
| S3 | **`npm run seed` has no production guard.** | Run by mistake on the live database, it creates the demo brands and rewards. | 🟠 |
| S4 | **New anonymous devices are not limited per network address.** | A script can make unlimited "new phones", each earning pending points, and flood `scan_events`. The points cannot be claimed without a verified phone, but the data grows without limit. | 🟠 |
| S5 | **No security headers** (Content-Security-Policy, frame protection, HSTS), and `X-Powered-By: Express` is sent. | The admin panel could be framed (clickjacking), and a strict CSP is the best defence if an injection bug ever appears. The user page is now CSP-ready: its colours moved to `theme.css`. | 🟠 |
| S6 | **Anyone can lock a brand admin out.** Five wrong passwords lock that email for 15 minutes, whoever sends them. | Anyone who knows or guesses an admin's email can keep them locked out. This is the usual trade-off of lockouts; a per-IP limit exists, but many addresses can still do it. | 🟡 |
| S7 | **Admin password rule is length only (10+).** No two-step login for admins. | `12345678911` is accepted. A super admin account controls every brand. | 🟠 |
| S8 | **User-app POSTs accept any content type** (the admin API requires JSON). | Lower risk because of SameSite cookies, but inconsistent with the admin API. | 🟢 |
| S9 | **Passwords were shared in chat during testing.** | Local test accounts only. Never reuse them on a real server. | 🟡 |

## 2. Reliability and operations

| # | Issue | Why it matters | Priority |
|---|---|---|---|
| R1 | **Malformed JSON returns 500** and prints a stack trace. | Should be a 400; noisy logs hide real errors. | 🟡 |
| R2 | **Unknown routes return Express's default HTML page**, including `/admin/api/...` calls. | API clients expect JSON; the page reveals the framework. | 🟢 |
| R3 | **`/health` returns 200 when the database or Redis is down** (the body says `degraded`). | Railway would keep sending traffic to a broken instance. | 🟠 |
| R4 | **No structured logs, request ids or graceful shutdown.** | Hard to trace a customer complaint. Requests in flight are cut off on every deploy. | 🟠 |
| R5 | **Postgres SSL is hard-coded on in production.** | May not match Railway's private network. Should be a setting (`DATABASE_SSL`). | 🟠 |
| R6 | **Not deployed.** No Railway config, no cron service for the nightly `npm run expire`, Node version not pinned. | Without the cron job, expired points never get `expire` lines (balances are still right, but the ledger is incomplete) and expired vouchers are never marked. | 🔴 for launch |
| R7 | **No backups, monitoring or alerting plan.** | The ledger is the only record of customers' points. | 🟠 |
| R8 | **Schema changes live in one idempotent `schema.sql`**, with no numbered migrations. | Adding things works, but renaming or reshaping a column on a live database gets risky. | 🟡 |
| R9 | **No CI.** Tests run only when someone runs them. | A change can break tenant isolation without anyone noticing. | 🟡 |

## 3. OTP and SMS

| # | Issue | Why it matters | Priority |
|---|---|---|---|
| O1 | **Real SMS never delivered.** MSG91 accepts our requests, but the DLT Entity ID and Template ID are not linked to the sender. | No real customer can sign up until this is done. | 🔴 for launch |
| O2 | **The per-IP OTP limit (10 per hour per brand) is likely too strict for Indian mobile networks.** Carriers put many phones behind one shared address (CGNAT), and a shop's Wi-Fi does the same. | At a busy counter or a contractor site, genuine customers could see "Too many codes requested". Found in testing: the laptop hit the limit. | 🟠 |
| O3 | **Refused requests still count toward the limits.** In testing the per-address counter reached 17 against a limit of 10. The window does not extend, but both counters go up on every tap, even when only the per-phone limit refused it. | One customer tapping **Send code** repeatedly uses up the shared allowance for everyone else on the same network (see O2). | 🟡 |
| O4 | **Test mode applies to all brands at once** (one server-wide key). | A staging or demo brand cannot use test mode while real brands send real SMS on the same server. | 🟢 |

## 4. Admin panel

| # | Issue | Why it matters | Priority |
|---|---|---|---|
| A1 | **The brand switcher shows the brand's original name, not its current Brand name.** After a brand admin renamed "Demo Works" to "Demo Works12", the super admin still saw "Demo Works". The fix is proposed and awaiting approval. | The super admin sees a name the brand no longer uses. | 🟡 |
| A2 | **A brand admin's top bar shows no brand name** (only "Loyalty Admin"). | They cannot confirm which brand they are managing. | 🟡 |
| A3 | **No way to find a voucher by its code.** Redemptions can only be filtered by status. | At a busy counter, the admin has to scroll the Issued list to match the customer's code. | 🟠 |
| A4 | **No screens to manage admins**: list, reset password, deactivate. An admin who has made changes cannot be deleted (the audit log keeps them). | Everything is manual SQL or Redis commands ([ACCOUNTS.md](ACCOUNTS.md)). | 🟠 |
| A5 | **No screen for the audit log.** Changes are recorded in `admin_action_log` but can only be read in the database. | A brand cannot see what the super admin changed in their account, or who fulfilled a voucher. | 🟡 |
| A6 | **No screen to create, rename or deactivate a brand.** Creating uses `npm run tenant:create`; deactivating needs SQL. | Fine for now, since only the platform owner does this. | 🟢 |
| A7 | **Customers cannot be deleted, blocked or have their phone number changed.** | Deletion requests under India's data protection law (DPDP Act) and banning abusers need manual SQL. | 🟠 |
| A8 | **No export** (CSV) of users, ledger or redemptions. | Brands will ask for reports. | 🟢 |
| A9 | **Settings are checked one field at a time, never against each other.** For example, "expiring soon" (up to 90 days) can be longer than the points' own life. | Confusing warnings for customers. | 🟢 |
| A10 | **Rewards cannot be deleted** (by design; deactivate instead). **Images are by URL only**; no upload. **Only vouchers**; the `product` type is not built. | Brands need somewhere to host reward images. | 🟢 |

## 5. Customer app

| # | Issue | Why it matters | Priority |
|---|---|---|---|
| U1 | **The "scanned recently" screen repeats itself**: the heading and the message say the same thing. | Copy polish. | 🟢 |
| U2 | **Pending points live in the phone's browser cookie.** Clearing cookies, private browsing or another browser on the same phone loses them. | Customers may say "my points vanished" before they have verified. | 🟡 |
| U3 | **After a scan the address changes to `/t/<brand>/`**, so reloading does not scan again. | Intended (prevents double counting), but surprised testers during the demo rehearsal. Documented. | 🟢 |
| U4 | **No customer notifications**: no SMS or WhatsApp when a voucher is issued, fulfilled or about to expire, or when points are expiring. | Customers only find out by opening the app. | 🟢 |
| U5 | **No QR code generation.** The brand makes its own QR from the URL. | An extra step for every new brand. | 🟢 |
| U6 | **English only.** | Many carpenters and contractors may prefer Hindi or a regional language. | 🟡 |

## 6. Testing gaps

| # | Gap | Priority |
|---|---|---|
| T1 | Real SMS send and verify (blocked by O1). | 🔴 for launch |
| T2 | Automated browser tests use Chromium only: not yet checked on real Android or iPhone, Safari or Firefox. | 🟠 |
| T3 | No load test (many scans at once, a busy redemption day). | 🟡 |
| T4 | Screens not covered by automated tests: log out, resend code, network errors, the OTP rate-limit message, copy-code on plain http. | 🟡 |
| T5 | The nightly expiry job has never run on a schedule, only by hand and in tests. | 🟠 |
| T6 | No formal accessibility check (screen readers, contrast); basic labels and reduced motion only. | 🟢 |

## 7. Code and data tidiness

| # | Issue | Priority |
|---|---|---|
| C1 | `tenants.brand_name`, `tenants.tagline` and `tenants.colors` are kept but never read (Settings is the source of truth). They can mislead anyone reading the database, and are part of A1. | 🟢 |
| C2 | The `device_tokens` table is unused (device ids live on `scan_events`). | 🟢 |
| C3 | The README's project structure is out of date: it lists a `design/` folder that does not exist and `src/public`, which is really top-level `public/`. A full README rewrite is part of Phase 8. | 🟢 |

## 8. Documents and demo material

| # | Issue | Priority |
|---|---|---|
| D1 | The seeded brand is "Demo Works", but the screenshots and slides say "Demo Plywood". The demo preparation renames it by hand. | 🟢 |
| D2 | The slide deck still has placeholders: presenter name and date on the cover; domain and support contact in the speaker notes. The deck is private until it is shared from its Share menu. | 🟡 |
| D3 | Untracked files in `docs/` (HTML copies, the `.pptx`, `docs/Demo/`, Windows `Zone.Identifier` files) are not in git. Decide which to keep; `*:Zone.Identifier` could be added to `.gitignore`. | 🟢 |

---

## Suggested order

1. **Before any public server:** S1, S2, R6, O1 (then T1, T5), R3, R5.
2. **Before the first client goes live:** S3, S4, S5, S7, R4, R7, O2, A3, A4, A7, T2.
3. **Then:** A1 and A2 (fix already proposed), and the remaining 🟡 items.
4. **Later:** the 🟢 items.
