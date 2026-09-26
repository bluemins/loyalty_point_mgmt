const { pool } = require("./index");
const { env } = require("../config/env");

async function seed() {
  const tenantResult = await pool.query(
    `
      INSERT INTO tenants (slug, name, brand_name, tagline, colors, active)
      VALUES ($1, $2, $3, $4, $5::jsonb, true)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, slug, name
    `,
    [
      env.DEMO_TENANT_SLUG,
      env.DEMO_TENANT_NAME,
      env.DEMO_TENANT_NAME,
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
      [env.DEMO_TENANT_SLUG]
    )
  ).rows[0];

  const settings = [
    ["brand_name", env.DEMO_TENANT_NAME],
    ["tagline", "Trusted materials for every build"],
    ["colors", { b1: "#0F172A", b2: "#1D4ED8", soft: "#F8FAFC" }],
    ["points_per_scan", 10],
    ["scan_cooldown_minutes", 10],
    ["daily_scan_cap", 5],
    ["points_expiry_days", 60],
    ["voucher_validity_days", 30],
    ["user_categories", ["Carpenter", "Contractor", "End User"]],
    ["msg91_sender_id", env.MSG91_SENDER_ID],
    ["msg91_template_id", env.MSG91_TEMPLATE_ID]
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
      `
        INSERT INTO rewards (tenant_id, type, name, description, image_url, points_cost, stock, active, is_catalog_ready)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        ON CONFLICT DO NOTHING
      `,
      [tenant.id, type, name, description, imageUrl, pointsCost, stock, active]
    );
  }

  console.log(`Seeded demo tenant: ${tenant.slug}`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
