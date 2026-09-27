// Creates a brand (tenant), and optionally its first tenant_admin.
//   npm run tenant:create                  (asks for everything)
//   npm run tenant:create -- --slug acme-plywood --name "Acme Plywood"
//        [--categories "Carpenter,Contractor,End User"] [--admin-email shop@acme.com]
// With --slug nothing is asked except the admin password (or ADMIN_PASSWORD),
// so it can run from a script.
const { pool } = require("../db");
const { createTenant, DEFAULT_CATEGORIES } = require("../services/tenantSetup");
const { flag, ask, askPassword, closePrompts } = require("./prompt");

const splitList = (text) => text.split(",").map((item) => item.trim()).filter(Boolean);

async function main() {
  const scripted = flag("slug") !== undefined;
  const slug = scripted ? flag("slug") : await ask("Slug (used in the QR URL, e.g. acme-plywood): ");
  const name = scripted ? flag("name") : await ask("Brand name: ");
  if (!name) throw new Error("A brand name is required (--name).");

  let categories = DEFAULT_CATEGORIES;
  const categoriesText = scripted
    ? flag("categories")
    : await ask(`User categories, comma-separated [${DEFAULT_CATEGORIES.join(", ")}]: `);
  if (categoriesText) categories = splitList(categoriesText);

  const adminEmail = scripted ? flag("admin-email") : await ask("Brand admin email (Enter to skip): ");
  const admin = adminEmail ? { email: adminEmail, password: await askPassword() } : null;

  const result = await createTenant(pool, { slug, name, categories, admin });

  console.log(`Created brand ${result.tenant.slug} (${result.tenant.name})`);
  console.log(`  QR code URL: <your domain>/t/${result.tenant.slug}/scan`);
  console.log(`  Categories:  ${categories.join(", ")}`);
  if (result.admin) console.log(`Created tenant_admin ${result.admin.email}`);
  console.log("Next: sign in to /admin as super admin and set this brand's colours, logo, tagline and rewards.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  })
  .finally(closePrompts);
