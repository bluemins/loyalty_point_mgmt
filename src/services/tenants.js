const { tenantQuery } = require("../db/tenantDb");

// Fallbacks used when a tenant has not set a key in the settings table.
const SETTING_DEFAULTS = {
  points_per_scan: 10,
  scan_cooldown_minutes: 10,
  daily_scan_cap: 5,
  points_expiry_days: 60,
  pending_points_ttl_days: 30,
  expiring_soon_days: 7,
  voucher_validity_days: 30,
  otp_send_limit_per_phone: 3,
  otp_send_window_phone_minutes: 15,
  otp_send_limit_per_ip: 10,
  otp_send_window_ip_minutes: 60
};

// tenants is the root table (it has no tenant_id), so it is looked up directly.
async function findTenantBySlug(db, slug) {
  const result = await db.query(
    "SELECT id, slug, name FROM tenants WHERE slug = $1 AND active = true",
    [slug]
  );
  return result.rows[0] || null;
}

async function getSettings(db, tenantId) {
  const result = await tenantQuery(
    db,
    tenantId,
    "SELECT key, value FROM settings WHERE tenant_id = $1"
  );
  const settings = { ...SETTING_DEFAULTS };
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// Express middleware for /t/:slug routes: sets req.tenant or responds 404.
async function resolveTenant(req, res, next) {
  try {
    const tenant = await findTenantBySlug(req.app.locals.db, req.params.slug);
    if (!tenant) {
      return res.status(404).json({ error: "tenant_not_found" });
    }
    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { SETTING_DEFAULTS, findTenantBySlug, getSettings, resolveTenant };
