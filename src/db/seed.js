const { pool } = require("./index");
const { env } = require("../config/env");

// Two demo tenants with contrasting themes, so theming is always testable.
// The first uses a plywood palette: walnut, teak amber and pine cream.
const DEMO_TENANTS = [
  {
    slug: env.DEMO_TENANT_SLUG,
    name: env.DEMO_TENANT_NAME,
    tagline: "Trusted materials for every build",
    colors: { b1: "#4A2412", b2: "#C8742B", soft: "#FBF3E6" },
    heroTexture: "wood"
  },
  {
    slug: "demo-laminates",
    name: "Demo Laminates",
    tagline: "Surfaces that last a lifetime",
    colors: { b1: "#0F3D3E", b2: "#1F8A70", soft: "#EEF7F4" },
    heroTexture: "none"
  }
];

// Idempotent: safe to run any number of times. Tests pass their own slug so
// they never touch the demo tenants.
async function seed({
  slug = DEMO_TENANTS[0].slug,
  name = DEMO_TENANTS[0].name,
  tagline = DEMO_TENANTS[0].tagline,
  colors = DEMO_TENANTS[0].colors,
  heroTexture = DEMO_TENANTS[0].heroTexture
} = {}) {
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
      tagline,
      JSON.stringify(colors)
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
    ["tagline", tagline],
    ["colors", colors],
    ["hero_texture", heroTexture],
    ["points_per_scan", 10],
    ["scan_cooldown_minutes", 10],
    ["daily_scan_cap", 5],
    ["points_expiry_days", 60],
    ["pending_points_ttl_days", 30],
    ["expiring_soon_days", 7],
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

module.exports = { seed, DEMO_TENANTS };

async function seedDemoTenants() {
  const seeded = [];
  for (const demo of DEMO_TENANTS) seeded.push(await seed(demo));
  return seeded;
}

if (require.main === module) {
  seedDemoTenants()
    .then((tenants) => {
      console.log(`Seeded demo tenants: ${tenants.map((t) => t.slug).join(", ")}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
