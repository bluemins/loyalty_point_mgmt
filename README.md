# QR Loyalty Platform

A multi-tenant, white-label loyalty and rewards system. End users scan a shared QR code at a work site or store, verify their phone number by OTP, earn points, and redeem rewards. Built to be sold to multiple clients from a single codebase.

## How it works

1. Anyone scans the QR code, no login required.
2. The scan is recorded and points are held as "pending" against a device token.
3. The user enters their phone number and verifies with an OTP.
4. New number: a profile is created and the pending points are credited.
5. Existing number: the user logs in, pending points merge into their balance, and they see their total, expiring points, and activity.
6. Points can be redeemed for rewards (vouchers to start, an e-commerce-style catalog later) once the user has enough balance.

Each client (tenant) gets their own branding, colors, logo, user categories, points rules, and reward catalog, all served from one deployment.

## Tech stack

- **Backend:** Node.js, Express
- **Database:** PostgreSQL (system of record, append-only points ledger)
- **Cache/rate limiting:** Redis (scan cooldown, daily cap, OTP limits, device tokens)
- **OTP:** MSG91 REST API
- **Frontend:** Mobile-first HTML, CSS, vanilla JS served by Express (no build step)
- **Hosting:** Railway (separate project from other apps)

## How OTP is working 

<img width="980" height="447" alt="image" src="https://github.com/user-attachments/assets/913b03d8-40e5-41aa-a2dc-3f1b29e170fe" />


We never see the real OTP. MSG91 generates it, texts it, and checks it. We only enforce the 5-minute expiry and the 5-attempt limit ourselves, so the rules are the same in mock and real mode.
Mode is chosen automatically. If MSG91_AUTH_KEY is empty you're in mock mode (OTP 000000, and responses include "mock": true). If it's set, real SMS go out.
The auth key stays on the server. It goes only in the authkey request header to MSG91 (src/services/msg91.js) and is never sent to the browser.

## Project structure

```
.
├── CLAUDE.md          # project brief and build rules for Claude Code
├── design/            # reference UI mockups
├── src/
│   ├── routes/        # Express route handlers
│   ├── services/      # OTP, ledger, redemption, tenant logic
│   ├── db/            # migrations, queries
│   └── public/         # frontend screens (scan, OTP, points home, rewards)
├── .env.example
└── package.json
```

## Getting started

### Prerequisites

- Node.js (LTS)
- PostgreSQL
- Redis
- An MSG91 account (or use mock OTP mode for local development)

### Setup

```bash
git clone <repo-url>
cd qr-loyalty-platform
npm install
cp .env.example .env   # fill in your values
npm run migrate        # set up the database
npm run seed           # create a demo tenant
npm run dev
```

### Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `MSG91_AUTH_KEY` | MSG91 API key (leave unset to use mock OTP mode) |
| `SESSION_SECRET` | Signs user and admin session cookies |
| `POINTS_PER_SCAN`, `SCAN_COOLDOWN_MINUTES`, `DAILY_SCAN_CAP`, `POINTS_EXPIRY_DAYS` | Default values; overridable per tenant in the `settings` table |

Never commit real secrets. `.env` is gitignored.

## Multi-tenancy

Every table carries a `tenant_id`. A tenant is resolved from the QR URL, e.g. `/t/<tenant-slug>/scan`. Users are unique per `(tenant_id, phone)`, so the same phone number can belong to different tenants independently. Admins are either `super_admin` (all tenants) or `tenant_admin` (their tenant only).

## Testing

```bash
npm test
```

Covers: daily scan cap, scan cooldown, FIFO point expiry on redemption, double-spend prevention, and tenant data isolation.

## Deployment

Runs on Railway as its own project, with Postgres and Redis as separate services, and a scheduled job for nightly points expiry. Set all environment variables in the Railway dashboard.

## Status

In active development. See `CLAUDE.md` for the current build phase and design decisions.
