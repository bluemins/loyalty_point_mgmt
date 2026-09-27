const { inTransaction } = require("../db/transaction");
const { SETTINGS_SCHEMA } = require("./adminData");
const { createAdmin } = require("./adminAuth");

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_CATEGORIES = ["Carpenter", "Contractor", "End User"];

function check(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}: ${result.error.issues[0].message}`);
  return result.data;
}

// Creates a brand with its name and user categories, and optionally its first
// tenant_admin, in one transaction: a bad admin email or password leaves no
// half-made brand behind. Every other setting uses the app defaults until an
// admin changes it in the panel.
async function createTenant(db, { slug, name, categories = DEFAULT_CATEGORIES, admin = null }) {
  // The slug is printed in QR codes, so it is kept short, lowercase and URL-safe.
  if (typeof slug !== "string" || slug.length < 2 || slug.length > 40 || !SLUG.test(slug)) {
    throw new Error("slug must be 2-40 lowercase letters, numbers and single hyphens, e.g. acme-plywood");
  }
  const brandName = check(SETTINGS_SCHEMA.brand_name, name, "brand name");
  const userCategories = check(SETTINGS_SCHEMA.user_categories, categories, "categories");

  try {
    return await inTransaction(db, async (client) => {
      const { rows } = await client.query(
        "INSERT INTO tenants (slug, name, brand_name) VALUES ($1, $2, $2) RETURNING id, slug, name",
        [slug, brandName]
      );
      const tenant = rows[0];
      await client.query(
        `INSERT INTO settings (tenant_id, key, value)
         VALUES ($1, 'brand_name', $2::jsonb), ($1, 'user_categories', $3::jsonb)`,
        [tenant.id, JSON.stringify(brandName), JSON.stringify(userCategories)]
      );
      const createdAdmin = admin
        ? await createAdmin(client, { email: admin.email, password: admin.password, role: "tenant_admin", tenantId: tenant.id })
        : null;
      return { tenant, admin: createdAdmin };
    });
  } catch (error) {
    if (error.code === "23505" && error.constraint === "tenants_slug_key") {
      throw new Error(`A brand with slug "${slug}" already exists.`);
    }
    if (error.code === "23505") throw new Error("An admin with that email already exists.");
    throw error;
  }
}

module.exports = { createTenant, DEFAULT_CATEGORIES };
