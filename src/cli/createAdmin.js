// Creates an admin account.
//   npm run admin:create
//   npm run admin:create -- --email a@b.com --role tenant_admin --tenant demo
// Missing values are prompted for; the password is never echoed. For scripts,
// the password can come from ADMIN_PASSWORD instead.
const { pool } = require("../db");
const { createAdmin } = require("../services/adminAuth");
const { flag, ask, askPassword, closePrompts } = require("./prompt");

async function main() {
  const email = flag("email") || (await ask("Email: "));
  const role = flag("role") || (await ask("Role (super_admin / tenant_admin): "));

  let tenantId = null;
  if (role === "tenant_admin") {
    const slug = flag("tenant") || (await ask("Tenant slug: "));
    const { rows } = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
    if (!rows[0]) throw new Error(`No tenant with slug "${slug}"`);
    tenantId = rows[0].id;
  }

  const password = await askPassword();
  const admin = await createAdmin(pool, { email, password, role, tenantId });
  console.log(`Created ${admin.role} ${admin.email}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.code === "23505" ? "An admin with that email already exists." : error.message);
    process.exit(1);
  })
  .finally(closePrompts);
