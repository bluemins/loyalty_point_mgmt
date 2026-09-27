# Creating users, brands and admins

For the platform owner (super admin) and whoever operates the server. It covers how each kind of account comes into existence, and the manual procedures that have no screen yet.

| Account | Who creates it | How |
|---|---|---|
| **User** (carpenter, contractor, customer) | The user, themselves | Scan QR → verify phone by SMS → profile |
| **Brand** (tenant) | Platform owner | `npm run tenant:create` |
| **Tenant admin** | Platform owner | `npm run tenant:create` (with the brand) or `npm run admin:create` |
| **Super admin** | Platform owner | `npm run admin:create` |

Commands below run from the project folder with the server's environment (`.env` locally). In WSL, load Node first with `. ~/.nvm/nvm.sh`.

---

## 1. Users (self-service)

Nobody creates users by hand. A user account is created the first time someone:

1. scans a brand's QR code (`https://<domain>/t/<brand-slug>/scan`),
2. verifies their phone with the SMS code, and
3. enters their name and category on the profile screen.

Rules:

- **A user is one phone number in one brand.** The same number in two brands is two separate accounts with separate points.
- The phone number is the identity. There is no email or password for users.
- Users cannot change their phone number. A new number is a new account; an admin can move points between the two with adjustments (see [ADMIN_GUIDE.md](ADMIN_GUIDE.md)).
- A brand must have at least one **category** in its settings before anyone can finish the profile screen.
- **Not supported yet:** deleting a user or changing a user's phone number.

---

## 2. Brands (tenants)

Each brand has a **slug**, the short name in its URLs. It is permanent, because it is printed in QR codes.

- Use lowercase letters, numbers and hyphens: `acme-plywood`.
- QR code URL: `https://<your-domain>/t/acme-plywood/scan`
- The app also opens at `https://<your-domain>/t/acme-plywood/`

### Local development

`npm run seed` creates two demo brands, `demo` (wood theme) and `demo-laminates` (teal), each with default settings and 3 rewards. It is safe to run again. Do not run it in production.

### Creating a brand

```bash
npm run tenant:create
```
It asks for:

- **Slug**: 2–40 lowercase letters, numbers and single hyphens, e.g. `acme-plywood`.
- **Brand name**: shown in the app, 1–60 characters.
- **User categories**, comma-separated. Press Enter for the default: `Carpenter, Contractor, End User`.
- **Brand admin email**, optional. If you give one, it also asks for that admin's password (twice, not shown) and creates the `tenant_admin` for this brand. Press Enter to skip; you can add admins later with `npm run admin:create`.

The brand and its admin are created together: if the admin fails (for example, the email is taken or the password is too short), no brand is created either, and you can run it again.

Without prompts (for example in a script):
```bash
ADMIN_PASSWORD='a-long-password' npm run tenant:create -- --slug acme-plywood --name "Acme Plywood" \
  --categories "Carpenter, Contractor, Architect" --admin-email shop@acme.com
```
`--categories` and `--admin-email` are optional. With `--slug`, nothing is asked except the admin password when `ADMIN_PASSWORD` is not set.

| Message | Meaning |
|---|---|
| `Created brand acme-plywood (Acme Plywood)` then the QR code URL | Done |
| `Created tenant_admin shop@acme.com` | The brand admin was created too |
| `A brand with slug "…" already exists.` | Choose another slug |
| `slug must be 2-40 lowercase letters…` | Fix the slug |
| `An admin with that email already exists.` | Use another email (nothing was created) |
| `password must be at least 10 characters` | Use a longer password (nothing was created) |

The new brand starts with the default scan and points rules (10 points per scan, 10-minute cooldown, 5 scans a day, 60-day expiry, 30-day vouchers), neutral grey colours and no rewards.

**Then set it up in the admin panel** as a super admin: choose the brand in the selector at the top, then:

1. **Settings**: tagline, logo URL, colours (and adjust the categories or rules if needed).
2. **Rewards**: add the rewards with their points cost and stock.
3. Optional: per-brand MSG91 sender ID and template ID. Blank uses the server defaults (`MSG91_SENDER_ID`, `MSG91_TEMPLATE_ID`). The brand's SMS template must be approved on DLT; see the README.

**If you skipped the brand admin**, create one now (section 3 below, role `tenant_admin`).

**Print the QR code** with the URL `https://<your-domain>/t/<slug>/scan`. Any QR generator works; the platform does not generate QR images.

To take a brand offline: `UPDATE tenants SET active = false WHERE slug = 'acme-plywood';`. Its pages and APIs then return "not found", and it disappears from the admin panel. Data is kept.

---

## 3. Admins

### Create an admin

```bash
npm run admin:create
```
It asks for:

- **Email**. Must look like `name@example.com`; stored in lowercase; must be unique.
- **Role**: `super_admin` (all brands) or `tenant_admin` (one brand).
- **Tenant slug**, only for `tenant_admin`.
- **Password**, twice, not shown while typing. At least 10 characters.

Without prompts (for example in a script):
```bash
ADMIN_PASSWORD='a-long-password' npm run admin:create -- --email owner@example.com --role super_admin
ADMIN_PASSWORD='a-long-password' npm run admin:create -- --email shop@acme.com --role tenant_admin --tenant acme-plywood
```

| Message | Meaning |
|---|---|
| `Created tenant_admin shop@acme.com` | Done |
| `An admin with that email already exists.` | Use another email |
| `No tenant with slug "…"` | Check the slug |
| `password must be at least 10 characters` | Use a longer password |
| `email must look like name@example.com` | Fix the email |

**The very first account** must be a `super_admin`, created this way. After that, the super admin sets up brands in the panel, but admin accounts are still created with this command.

**In production (Railway):** this command and `npm run tenant:create` need the production `DATABASE_URL` and `REDIS_URL`. Run it in a shell on the deployed web service, or locally with those values. The exact Railway steps are part of the deployment guide in the README (Phase 8).

### Manual procedures (no screen yet)

Run these on the server's database (`psql`) and Redis (`redis-cli`). Replace the email.

**Unlock an admin locked out by failed logins** (otherwise it unlocks itself after 15 minutes):
```bash
redis-cli del adm:rl:email:shop@acme.com
```

**Reset a password:**
```bash
# 1. Make a hash of the new password
node -e "require('./src/services/passwords').hashPassword(process.argv[1]).then(console.log)" 'the-new-password'
```
```sql
-- 2. Store it
UPDATE admin_users SET password_hash = '<hash from step 1>', updated_at = NOW() WHERE email = 'shop@acme.com';
```

**Sign an admin out everywhere** (for example a lost laptop):
```bash
ID=$(psql "$DATABASE_URL" -Atc "SELECT id FROM admin_users WHERE email = 'shop@acme.com'")
redis-cli --scan --pattern "adm:sess:$ID:*" | xargs -r redis-cli del
```

**Change a role or brand:**
```sql
UPDATE admin_users SET role = 'tenant_admin', tenant_id = (SELECT id FROM tenants WHERE slug = 'acme-plywood') WHERE email = 'shop@acme.com';
-- super_admin must have tenant_id NULL; tenant_admin must have one (the database enforces this).
```
The change applies on their next request.

**Remove an admin:**
```sql
DELETE FROM admin_users WHERE email = 'shop@acme.com';
```
Their sessions stop working at once. **This fails if the admin has made changes**, because the audit log keeps who did what. For such an admin, reset their password to a random value and sign them out everywhere. A proper "deactivate" option is planned (see [STATUS.md](STATUS.md)).
