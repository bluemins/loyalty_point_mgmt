const { pool } = require("./index");
const { env } = require("../config/env");

// Idempotent: safe to run any number of times. Tests pass their own slug so
// they never touch the demo tenant.
async function seed({ slug = env.DEMO_TENANT_SLUG, name = env.DEMO_TENANT_NAME } = {}) {
  const tenantResult = await pool.query(
    `
      INSERT INTO tenants (slug, name, brand_name, tagline, colors, active)
      VALUES ($1, $2, $3, $4, $5::jsonb, true)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, slug, name
    `,
    [
      slug,
      name,
      name,
      "Trusted materials for every build",
      JSON.stringify({
        b1: "#0F172A",
        b2: "#1D4ED8",
        soft: "#F8FAFC"
      })
    ]
  );

  const tenant = tenantResult.rows[0] || (
    await pool.query(
      "SELECT id, slug, name FROM tenants WHERE slug = $1",
      [slug]
    )
  ).rows[0];

  const settings = [
    ["brand_name", name],
    ["tagline", "Trusted materials for every build"],
    ["colors", { b1: "#0F172A", b2: "#1D4ED8", soft: "#F8FAFC" }],
    ["points_per_scan", 10],
    ["scan_cooldown_minutes", 10],
    ["daily_scan_cap", 5],
    ["points_expiry_days", 60],
    ["pending_points_ttl_days", 30],
    ["voucher_validity_days", 30],
    ["user_categories", ["Carpenter", "Contractor", "End User"]],
    ["msg91_sender_id", env.MSG91_SENDER_ID],
    ["msg91_template_id", env.MSG91_TEMPLATE_ID],
    ["otp_send_limit_per_phone", 3],
    ["otp_send_window_phone_minutes", 15],
    ["otp_send_limit_per_ip", 10],
    ["otp_send_window_ip_minutes", 60]
  ];

  for (const [key, value] of settings) {
    await pool.query(
      `
        INSERT INTO settings (tenant_id, key, value)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (tenant_id, key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = NOW()
      `,
      [tenant.id, key, JSON.stringify(value)]
    );
  }

  const rewards = [
    ["voucher", "Starter Voucher", "10% off first purchase", "https://images.example.com/v1.jpg", 100, 20, true],
    ["voucher", "Trade Pack", "Free delivery on bulk order", "https://images.example.com/v2.jpg", 250, 10, true],
    ["voucher", "Loyalty Bonus", "Exclusive material credit", "https://images.example.com/v3.jpg", 500, 5, true]
  ];

  for (const [type, name, description, imageUrl, pointsCost, stock, active] of rewards) {
    await pool.query(
      // rewards has no unique key to conflict on, so skip by name instead.
      `
        INSERT INTO rewards (tenant_id, type, name, description, image_url, points_cost, stock, active, is_catalog_ready)
        SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::int, $7::int, $8::boolean, true
        WHERE NOT EXISTS (SELECT 1 FROM rewards WHERE tenant_id = $1 AND name = $3)
      `,
      [tenant.id, type, name, description, imageUrl, pointsCost, stock, active]
    );
  }

  return tenant;
}

module.exports = { seed };

if (require.main === module) {
  seed()
    .then((tenant) => {
      console.log(`Seeded demo tenant: ${tenant.slug}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
