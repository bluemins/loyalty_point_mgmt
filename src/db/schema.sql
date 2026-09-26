CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand_name TEXT,
  tagline TEXT,
  colors JSONB DEFAULT '{"b1":"#0F172A","b2":"#1D4ED8","soft":"#F8FAFC"}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  name TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS otp_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  send_count INT NOT NULL DEFAULT 0,
  attempt_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- MSG91 generates and holds the real OTP, so we usually have no hash to store.
ALTER TABLE otp_requests ALTER COLUMN otp_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  user_id UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id, token_hash)
);

CREATE TABLE IF NOT EXISTS scan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  device_token_hash TEXT,
  ip_address TEXT,
  user_agent TEXT,
  outcome TEXT NOT NULL,
  points_awarded INT NOT NULL DEFAULT 0,
  points_pending INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('scan', 'redeem', 'expire', 'adjust', 'refund')),
  amount INT NOT NULL,
  balance_after INT NOT NULL,
  reference_type TEXT,
  reference_id UUID,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('voucher', 'product')),
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  points_cost INT NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  is_catalog_ready BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id UUID NOT NULL REFERENCES rewards(id) ON DELETE RESTRICT,
  points_spent INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'fulfilled', 'cancelled')),
  voucher_code TEXT,
  voucher_expires_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  metadata JSONB,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'tenant_admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settings_tenant_key ON settings (tenant_id, key);
CREATE INDEX IF NOT EXISTS idx_users_tenant_phone ON users (tenant_id, phone_e164);
CREATE INDEX IF NOT EXISTS idx_otp_requests_phone_time ON otp_requests (tenant_id, phone_e164, created_at);
CREATE INDEX IF NOT EXISTS idx_device_tokens_tenant_user ON device_tokens (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_scan_events_tenant_created ON scan_events (tenant_id, created_at);

-- Balance is always derived from the ledger, so no running balance is stored.
ALTER TABLE ledger DROP COLUMN IF EXISTS balance_after;

-- Set when an anonymous pending scan is merged into a user, so it is claimed once.
ALTER TABLE scan_events ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scan_events_pending_device
  ON scan_events (tenant_id, device_token_hash) WHERE outcome = 'pending';
CREATE INDEX IF NOT EXISTS idx_scan_events_user_created
  ON scan_events (tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_user_created ON ledger (tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_user_expires ON ledger (tenant_id, user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_rewards_tenant_active ON rewards (tenant_id, active, points_cost);
CREATE INDEX IF NOT EXISTS idx_redemptions_tenant_status ON redemptions (tenant_id, status, created_at);

-- Each debit row (redeem, expire, negative adjust) draws from exactly one
-- credit. A debit spanning several credits is written as several rows. This is
-- what makes FIFO spending and per-credit expiry exact:
--   remaining(credit) = credit.amount + SUM(debits pointing at it)
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS consumes_ledger_id UUID REFERENCES ledger(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_ledger_consumes ON ledger (consumes_ledger_id);
CREATE INDEX IF NOT EXISTS idx_ledger_credit_expiry ON ledger (tenant_id, expires_at) WHERE amount > 0;
-- A credit can be expired only once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_expire_per_credit ON ledger (consumes_ledger_id) WHERE type = 'expire';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_credit_debit_shape') THEN
    ALTER TABLE ledger ADD CONSTRAINT ledger_credit_debit_shape CHECK (
      (amount > 0 AND expires_at IS NOT NULL AND consumes_ledger_id IS NULL)
      OR (amount < 0 AND consumes_ledger_id IS NOT NULL)
    );
  END IF;
END $$;

-- The ledger is append-only. Direct UPDATE or DELETE is rejected. A delete
-- cascading from removing a tenant or user runs inside the foreign-key
-- trigger (depth > 1), so it is still allowed.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'ledger is append-only: % is not allowed', TG_OP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_append_only ON ledger;
CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- Voucher codes are unique per tenant; users list their own redemptions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemptions_voucher_code ON redemptions (tenant_id, voucher_code);
CREATE INDEX IF NOT EXISTS idx_redemptions_tenant_user_created ON redemptions (tenant_id, user_id, created_at);

-- Vouchers past voucher_expires_at become 'expired' (final, no refund).
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
ALTER TABLE redemptions DROP CONSTRAINT IF EXISTS redemptions_status_check;
ALTER TABLE redemptions ADD CONSTRAINT redemptions_status_check
  CHECK (status IN ('issued', 'fulfilled', 'cancelled', 'expired'));
CREATE INDEX IF NOT EXISTS idx_redemptions_issued_expiry
  ON redemptions (tenant_id, voucher_expires_at) WHERE status = 'issued';

-- A super_admin has no tenant; a tenant_admin has exactly one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_role_tenant') THEN
    ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_tenant CHECK (
      (role = 'super_admin' AND tenant_id IS NULL) OR (role = 'tenant_admin' AND tenant_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_email_lowercase') THEN
    ALTER TABLE admin_users ADD CONSTRAINT admin_users_email_lowercase CHECK (email = lower(email));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_admin_action_log_tenant_created ON admin_action_log (tenant_id, created_at);

-- Deleting an admin must not erase their audit trail (was ON DELETE CASCADE).
-- NO ACTION still allows removing a whole tenant in one statement.
ALTER TABLE admin_action_log DROP CONSTRAINT IF EXISTS admin_action_log_admin_user_id_fkey;
ALTER TABLE admin_action_log ADD CONSTRAINT admin_action_log_admin_user_id_fkey
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE NO ACTION;
