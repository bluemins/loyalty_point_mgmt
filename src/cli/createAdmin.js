// Creates an admin account.
//   npm run admin:create
//   npm run admin:create -- --email a@b.com --role tenant_admin --tenant demo
// Missing values are prompted for; the password is never echoed. For scripts,
// the password can come from ADMIN_PASSWORD instead.
const readline = require("readline");
const { pool } = require("../db");
const { createAdmin } = require("../services/adminAuth");

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (question) => new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));

function askHidden(question) {
  return new Promise((resolve) => {
    const write = rl._writeToOutput;
    rl._writeToOutput = (text) => {
      if (text.includes(question)) write.call(rl, text);
    };
    rl.question(question, (answer) => {
      rl._writeToOutput = write;
      rl.output.write("\n");
      resolve(answer);
    });
  });
}

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

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await askHidden("Password (min 10 characters): ");
    if ((await askHidden("Repeat password: ")) !== password) throw new Error("Passwords do not match");
  }

  const admin = await createAdmin(pool, { email, password, role, tenantId });
  console.log(`Created ${admin.role} ${admin.email}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.code === "23505" ? "An admin with that email already exists." : error.message);
    process.exit(1);
  })
  .finally(() => rl.close());
