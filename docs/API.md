# API reference

For developers integrating with or maintaining the loyalty platform. All endpoints return JSON unless noted.

- **User app API**: `/t/:slug/...`, where `:slug` identifies the tenant (for example `demo`).
- **Admin API**: `/admin/api/...`.
- Every configurable number mentioned below (points per scan, limits, days) is a per-tenant setting; the defaults are shown.

## Conventions

**Errors** always look like `{ "error": "<code>", ...extra }`. The `error` code is stable; show your own message for it.

**Tenant not found**: any `/t/:slug/...` request for an unknown or inactive slug returns `404 {"error":"tenant_not_found"}`. A browser navigating to a page URL (`Accept: text/html`) gets a short HTML page instead ("This link is not valid…").

**Cookies** (all signed and `httpOnly`; the browser handles them, never read or set them from JavaScript):

| Cookie | Set by | Path | Lifetime | Purpose |
|---|---|---|---|---|
| `sid` | `POST /t/:slug/otp/verify` | `/t/<slug>` | 30 days (`SESSION_TTL_DAYS`) | User session. The session itself lives in Redis, so logout takes effect immediately. |
| `dt` | `POST /t/:slug/scan` (first anonymous scan) | `/t/<slug>` | 1 year | Anonymous device id. Pending points are held against it. |
| `asid` | `POST /admin/api/login` | `/admin` | 12 hours (`ADMIN_SESSION_TTL_HOURS`) | Admin session, `SameSite=Strict`. |

Because cookies are scoped to `/t/<slug>`, a user's session in one tenant is never sent to another tenant.

**Time**: timestamps are ISO 8601 in UTC. "Days" (daily scan cap, expiring-soon dates) follow India time (IST, UTC+5:30).

---

## System

### `GET /health`
Status of the app and its services.
```json
{ "status": "ok", "database": true, "redis": true, "app": "loyalty-demo" }
```
`status` is `"degraded"` when Postgres or Redis is unreachable. (Currently still HTTP 200; see [STATUS.md](STATUS.md).)

### `GET /`
`{ "service": "<APP_NAME>", "status": "ok" }`

---

## User app: pages

### `GET /t/:slug/scan` (HTML)
The URL printed in the QR code. Returns the app page themed for the tenant. **It does not record a scan**; the page's JavaScript calls `POST /t/:slug/scan` after it loads, so link previews and prefetching never count as scans.

### `GET /t/:slug/` (HTML)
The same app for return visits (no scan).

### `GET /t/:slug/theme.css`
The tenant's colours as CSS variables, loaded by the app page (which has no inline styles). `Content-Type: text/css`, `Cache-Control: no-cache` with an ETag, so a colour saved in the admin panel shows on the next page load.
```css
:root { --b1: #4A2412; --b2: #C8742B; --soft: #FBF3E6; }
```
Colours that are not plain `#rrggbb` values fall back to neutral defaults (`#1F2937`, `#4B5563`, `#F9FAFB`).

### `GET /t/:slug/config`
Public tenant configuration used by the app.
```json
{
  "slug": "demo",
  "brand_name": "Demo Works",
  "brand_initials": "DW",
  "tagline": "Trusted materials for every build",
  "logo_url": null,
  "colors": { "b1": "#4A2412", "b2": "#C8742B", "soft": "#FBF3E6" },
  "hero_texture": "wood",
  "user_categories": ["Carpenter", "Contractor", "End User"],
  "points_per_scan": 10
}
```

---

## User app: login

### `POST /t/:slug/otp/send`
Sends a 6-digit OTP by SMS (MSG91). The phone is normalised to E.164; a number without a country code is treated as Indian (+91).

Request: `{ "phone": "98765 43210" }`

Response `200`:
```json
{ "ok": true, "phone": "+919876543210", "expires_in_seconds": 300 }
```
In mock mode (`MSG91_AUTH_KEY` empty) the response also has `"mock": true`, no SMS is sent and the code is always `000000`.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_phone` | Not a valid mobile number |
| 429 | `rate_limited` (+ `retry_after_seconds`) | More than 3 sends per phone per 15 min, or 10 per IP per hour |
| 502 | `otp_send_failed` | MSG91 rejected the request (the reason is logged on the server) |
| 502 | `otp_provider_unavailable` | MSG91 could not be reached |

A new send replaces the previous code and resets the attempt count.

### `POST /t/:slug/otp/verify`
Request: `{ "phone": "9876543210", "otp": "123456" }`

On success a `sid` session cookie is set, and:

- **Phone already registered** (pending points from this device are merged now):
  ```json
  { "ok": true, "phone": "+919876543210", "needs_profile": false, "merged_points": 20 }
  ```
- **New phone** (create a profile next):
  ```json
  { "ok": true, "phone": "+919876543210", "needs_profile": true, "pending_points": 20 }
  ```

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_phone` / `invalid_otp_format` | Bad phone, or the code is not 6 digits (not counted as an attempt) |
| 401 | `invalid_otp` (+ `attempts_left`) | Wrong code |
| 410 | `otp_expired` | No code sent, or it is older than 5 minutes |
| 429 | `too_many_attempts` | More than 5 attempts on this code; request a new one |
| 502 | `otp_provider_unavailable` | MSG91 could not be reached |

### `POST /t/:slug/profile`
Creates the user after a successful verify of a new phone, then claims this device's pending points.

Request: `{ "name": "Ravi Kumar", "category": "Carpenter" }` (`category` must be one of the tenant's `user_categories`).

Response `200`:
```json
{ "ok": true, "user": { "name": "Ravi Kumar", "category": "Carpenter", "phone": "+919876543210" }, "merged_points": 20 }
```

| Status | `error` | When |
|---|---|---|
| 401 | `not_authenticated` | No verified session |
| 409 | `profile_exists` | This session already has a profile |
| 400 | `invalid_name` | Empty or longer than 80 characters |
| 400 | `invalid_category` (+ `categories`) | Category not in the tenant's list |

### `GET /t/:slug/session`
```json
{ "authenticated": true, "phone": "+919876543210", "has_profile": true }
```
or `{ "authenticated": false }`.

### `POST /t/:slug/logout`
Deletes the session (server-side) and clears the cookie. `{ "ok": true }`

---

## User app: scanning

### `POST /t/:slug/scan`
Records one scan. No body needed. If the user is logged in with a profile, points are credited; otherwise they are held as pending against the `dt` device cookie (issued on the first scan).

Response `200` (always 200; `outcome` says what happened):
```json
{ "outcome": "pending", "points": 10, "message": "+10 points pending. Verify your phone to claim them.", "pending_points": 30 }
```

| `outcome` | Meaning | `points` |
|---|---|---|
| `credited` | Logged in: points added to the balance | points earned |
| `pending` | Anonymous: points held until the phone is verified | points held |
| `cooldown` | A scan earned points less than 10 min ago; also returns `retry_after_seconds` | 0 |
| `capped` | 5 earning scans already today (IST) | 0 |

`pending_points` (total pending on this device) is included for anonymous scans. Every scan, including refused ones, is logged in `scan_events`.

---

## User app: points and rewards

These need a logged-in user **with a profile**: `401 not_authenticated` without a session, `409 needs_profile` for a verified phone that has no profile yet.

### `GET /t/:slug/points`
```json
{
  "balance": 300,
  "expiring_soon": {
    "total": 30,
    "within_days": 7,
    "by_date": [{ "date": "2026-09-30", "points": 30 }]
  },
  "activity": [
    { "type": "redeem", "amount": -250, "created_at": "…", "expires_at": null },
    { "type": "scan", "amount": 10, "created_at": "…", "expires_at": "…" }
  ]
}
```
- `balance`: unspent points on credits that have not expired.
- `expiring_soon.by_date`: unspent points expiring in the next `expiring_soon_days`, grouped by IST date.
- `activity`: latest 50 entries, newest first. Types: `scan`, `redeem`, `refund`, `adjust`, `expire`. A redemption that drew from several credits appears as one entry.

### `GET /t/:slug/rewards` (public, no login)
Active rewards, cheapest first. Stock counts are not exposed.
```json
{ "rewards": [
  { "id": "…", "type": "voucher", "name": "Starter Voucher", "description": "10% off", "image_url": null, "points_cost": 100, "in_stock": true }
] }
```

### `POST /t/:slug/rewards/:rewardId/redeem`
Redeems a reward and issues a voucher, atomically.

**Header required**: `Idempotency-Key: <8–100 characters of A–Z a–z 0–9 _ ->`. Generate one per redeem intent (per confirmation) and **reuse it on retry**. The same key always returns the same voucher and never spends twice.

Response `201` (new) or `200` (same key again, `"replayed": true`):
```json
{
  "redemption": {
    "id": "…",
    "reward": { "id": "…", "name": "Trade Pack", "type": "voucher", "image_url": null },
    "points_spent": 250,
    "status": "issued",
    "voucher_code": "K7MQ-3XRD-9P",
    "voucher_expires_at": "…",
    "created_at": "…"
  },
  "replayed": false
}
```

| Status | `error` | When |
|---|---|---|
| 400 | `missing_idempotency_key` | Header missing or malformed |
| 404 | `reward_not_found` | Unknown, inactive, or another tenant's reward |
| 409 | `out_of_stock` | Stock is 0 |
| 409 | `insufficient_points` (+ `balance`, `points_cost`) | Not enough points; nothing is written |
| 409 | `idempotency_key_conflict` | Key already used by another user or for another reward |

### `GET /t/:slug/redemptions`
The user's vouchers, newest first (latest 50), same shape as `redemption` above. `status` is `issued`, `fulfilled`, `cancelled` or `expired` (a voucher past `voucher_expires_at` is reported as `expired` immediately).

---

## Admin API

All admin endpoints are under `/admin/api`. Requests that change data (`POST`, `PUT`) **must** send `Content-Type: application/json`, otherwise `415 {"error":"json_required"}`.

Without a valid admin session: `401 {"error":"not_authenticated"}`.

### `POST /admin/api/login`
Request: `{ "email": "admin@example.com", "password": "…" }`

Response `200` (sets the `asid` cookie):
```json
{ "email": "admin@example.com", "role": "tenant_admin", "tenants": [{ "slug": "demo", "name": "Demo Works" }] }
```

| Status | `error` | When |
|---|---|---|
| 401 | `invalid_credentials` | Wrong email **or** password (same answer for both) |
| 429 | `too_many_attempts` (+ `retry_after_seconds`) | 5 failed logins for this email in 15 min, or 20 from this IP in an hour |

### `POST /admin/api/logout`
Deletes the admin session. `{ "ok": true }`

### `GET /admin/api/me`
Same shape as the login response. `tenants` lists every active tenant for a `super_admin`, and only their own tenant for a `tenant_admin`.

### Tenant-scoped admin endpoints: `/admin/api/t/:slug/...`

A `super_admin` may use any tenant. A `tenant_admin` using any tenant other than their own gets `404 {"error":"tenant_not_found"}`, the same answer as for a tenant that does not exist. Ids in paths must be UUIDs, otherwise `404 {"error":"not_found"}`.

Every change below is recorded in `admin_action_log` (who, what, before/after, reason) in the same transaction as the change.

List endpoints return `{ "items": [...], "page": 1, "has_more": false }` with 50 items per page; pass `?page=2` for more.

#### `GET /users?q=&page=`
Users newest first, with their current balance. `q` searches phone and name (substring, case-insensitive).
Item: `{ "id", "phone_e164", "name", "category", "created_at", "balance" }`

#### `GET /users/:userId`
```json
{
  "user": { "id", "phone_e164", "name", "category", "status", "created_at" },
  "balance": 75,
  "ledger": [ { "id", "type", "amount", "reference_type", "reference_id", "expires_at", "created_at" } ],
  "redemptions": [ { "id", "status", "voucher_code", "points_spent", "voucher_expires_at", "created_at", "reward_name" } ]
}
```
Latest 100 ledger entries and 100 redemptions. `404 user_not_found` for an unknown user (or another tenant's).

#### `POST /users/:userId/adjust`
Request: `{ "amount": 50, "reason": "Goodwill for late delivery" }`. `amount` is a non-zero whole number (±1,000,000 max); a reason of 3–200 characters is required.

- Positive: adds one `adjust` credit that expires after `points_expiry_days`.
- Negative: removes points from the oldest credits first; cannot take the balance below zero.

Response: `{ "amount": 50, "balance": 125 }`

| Status | `error` |
|---|---|
| 400 | `invalid_amount`, `reason_required` |
| 404 | `user_not_found` |
| 409 | `insufficient_points` (+ `balance`) |

#### `GET /ledger?type=&user=&page=`
Every ledger entry of the tenant, newest first. Optional filters: `type` (`scan`, `redeem`, `refund`, `adjust`, `expire`), `user` (user id).
Item: `{ "id", "type", "amount", "reference_type", "reference_id", "expires_at", "created_at", "user_id", "phone_e164", "name" }`

#### `GET /redemptions?status=&page=`
Optional `status`: `issued`, `fulfilled`, `cancelled`, `expired`.
Item: `{ "id", "status", "voucher_code", "points_spent", "voucher_expires_at", "created_at", "fulfilled_at", "cancelled_at", "reward_name", "user_id", "phone_e164", "name" }`

#### `POST /redemptions/:redemptionId/fulfil`
Marks an issued voucher as used. Final. `{ "id": "…", "status": "fulfilled" }`

#### `POST /redemptions/:redemptionId/cancel`
Request: `{ "reason": "Out of stock at store" }` (3–200 characters). Refunds the points as one new credit with a fresh expiry and puts the stock back.
`{ "id": "…", "status": "cancelled", "refunded_points": 250 }`

Errors for fulfil and cancel:

| Status | `error` | When |
|---|---|---|
| 404 | `redemption_not_found` | Unknown (or another tenant's) redemption |
| 409 | `invalid_status` (+ `status`) | Not `issued`, or past its validity (`status: "expired"`) |
| 400 | `reason_required` | Cancel without a reason |

#### `GET /settings`
```json
{ "settings": { "brand_name": "…", "points_per_scan": 10, "…": "…" }, "editable": ["brand_name", "…"] }
```
`settings` holds the **effective** value of every editable setting (the default when the tenant never set it). `editable` lists what this admin may change.

#### `PUT /settings`
Send only the keys to change: `{ "points_per_scan": 15, "tagline": "New tagline" }`.
Response: `{ "changed": ["points_per_scan", "tagline"], "settings": {…}, "editable": [...] }`. Keys whose value did not change are not written or logged.

| Key | Rule |
|---|---|
| `brand_name` | text, 1–60 |
| `tagline` | text, up to 120 |
| `colors` | `{ "b1", "b2", "soft" }`, each `#RRGGBB` |
| `hero_texture` | `none` or `wood` |
| `logo_url` | `https://…`, `http://…` or `/path`, or `null` |
| `user_categories` | 1–10 unique names, each 1–40 characters |
| `points_per_scan` | 1–1000 |
| `scan_cooldown_minutes` | 0–1440 (0 = off) |
| `daily_scan_cap` | 1–100 |
| `points_expiry_days` | 1–3650 |
| `pending_points_ttl_days` | 1–365 |
| `expiring_soon_days` | 1–90 |
| `voucher_validity_days` | 1–3650 |
| `otp_send_limit_per_phone` \* | 1–20 |
| `otp_send_window_phone_minutes` \* | 1–1440 |
| `otp_send_limit_per_ip` \* | 1–1000 |
| `otp_send_window_ip_minutes` \* | 1–1440 |
| `msg91_sender_id` \* | 6 capital letters, or `null` for the server default |
| `msg91_template_id` \* | text 1–64, or `null` for the server default |

\* `super_admin` only.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_settings` | Body is empty or not an object |
| 400 | `unknown_setting` (+ `key`) | Not a known setting |
| 400 | `invalid_setting` (+ `key`, `message`) | Breaks the rule above |
| 403 | `forbidden_setting` (+ `key`) | A `tenant_admin` changing a super-admin-only key |

#### `GET /rewards`
All rewards including inactive ones, with stock:
`{ "rewards": [ { "id", "type", "name", "description", "image_url", "points_cost", "stock", "active", "created_at", "updated_at" } ] }`

#### `POST /rewards`
`{ "name": "Drill Set", "description": "…", "image_url": null, "points_cost": 400, "stock": 3, "active": true }`. `description`, `image_url` and `active` (default `true`) are optional. Only vouchers can be created for now. Returns `201` with the reward.

#### `PUT /rewards/:rewardId`
Any subset of the fields above, for example `{ "active": false }`. Returns the updated reward. Rewards cannot be deleted (issued vouchers refer to them); deactivate instead.

Errors: `400 invalid_reward` (+ `field`, `message`), `404 reward_not_found`.
