const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');

const { pool, redis } = require('../src/db');
const { createTenant } = require('../src/services/tenantSetup');
const { createAdmin, login } = require('../src/services/adminAuth');
const { getSettings } = require('../src/services/tenants');
const { getPublicConfig } = require('../src/services/theme');
const { destroyTestTenant, destroyTestAdmins } = require('./helpers');

const CLI = path.join(__dirname, '../src/cli/createTenant.js');
const created = { tenants: [], admins: [] };

const newSlug = () => `test-tc-${crypto.randomBytes(4).toString('hex')}`;
const newEmail = () => `test-tc-${crypto.randomBytes(4).toString('hex')}@example.test`;
const PASSWORD = 'a-long-test-password';

async function tenantsWithSlug(slug) {
  return (await pool.query('SELECT id, slug, name, brand_name FROM tenants WHERE slug = $1', [slug])).rows;
}

async function adminsWithEmail(email) {
  return (await pool.query('SELECT id, email, role, tenant_id FROM admin_users WHERE email = $1', [email])).rows;
}

// Registers what a test created, so teardown removes it even when an assert fails.
async function track(slug, email) {
  created.tenants.push(...(await tenantsWithSlug(slug)));
  if (email) created.admins.push(...(await adminsWithEmail(email)));
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr })
    );
  });
}

before(async () => {
  await redis.connect();
});

after(async () => {
  await destroyTestAdmins(pool, redis, created.admins);
  for (const tenant of created.tenants) await destroyTestTenant(pool, redis, tenant);
  await redis.quit();
  await pool.end();
});

test('creates a brand with its name and categories; everything else uses the defaults', async () => {
  const slug = newSlug();
  const { tenant, admin } = await createTenant(pool, { slug, name: 'Acme Plywood', categories: ['Carpenter', 'Dealer'] });
  await track(slug);

  assert.equal(admin, null);
  assert.deepEqual(await tenantsWithSlug(slug), [{ id: tenant.id, slug, name: 'Acme Plywood', brand_name: 'Acme Plywood' }]);

  const rows = (await pool.query('SELECT key, value FROM settings WHERE tenant_id = $1 ORDER BY key', [tenant.id])).rows;
  assert.deepEqual(rows, [
    { key: 'brand_name', value: 'Acme Plywood' },
    { key: 'user_categories', value: ['Carpenter', 'Dealer'] }
  ]);

  const settings = await getSettings(pool, tenant.id);
  assert.equal(settings.points_per_scan, 10);
  assert.equal(settings.daily_scan_cap, 5);
  const config = await getPublicConfig(pool, tenant);
  assert.equal(config.brand_name, 'Acme Plywood');
  assert.deepEqual(config.user_categories, ['Carpenter', 'Dealer']);
});

test('default categories are Carpenter, Contractor, End User', async () => {
  const slug = newSlug();
  const { tenant } = await createTenant(pool, { slug, name: 'Default Cats' });
  await track(slug);
  const settings = await getSettings(pool, tenant.id);
  assert.deepEqual(settings.user_categories, ['Carpenter', 'Contractor', 'End User']);
});

test('creates the brand admin too, and that admin can sign in', async () => {
  const slug = newSlug();
  const email = newEmail();
  const { tenant, admin } = await createTenant(pool, { slug, name: 'With Admin', admin: { email, password: PASSWORD } });
  await track(slug, email);

  assert.deepEqual(await adminsWithEmail(email), [{ id: admin.id, email, role: 'tenant_admin', tenant_id: tenant.id }]);
  const signedIn = await login({ db: pool, redis }, { email, password: PASSWORD, ip: '127.0.0.9' });
  assert.deepEqual(signedIn, { id: admin.id, email, role: 'tenant_admin', tenant_id: tenant.id });
});

test('invalid slugs are refused and nothing is written', async () => {
  for (const slug of ['Acme', 'a', '-acme', 'acme-', 'acme--ply', 'acme_ply', 'acme ply', 'x'.repeat(41), '', undefined]) {
    await assert.rejects(createTenant(pool, { slug, name: 'Bad Slug' }), /slug must be/, String(slug));
  }
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM tenants WHERE name = 'Bad Slug'");
  assert.equal(rows[0].n, 0);
});

test('invalid names and categories are refused', async () => {
  await assert.rejects(createTenant(pool, { slug: newSlug(), name: '   ' }), /brand name/);
  await assert.rejects(createTenant(pool, { slug: newSlug(), name: 'x'.repeat(61) }), /brand name/);
  await assert.rejects(createTenant(pool, { slug: newSlug(), name: 'No Cats', categories: [] }), /categories/);
  await assert.rejects(createTenant(pool, { slug: newSlug(), name: 'Dup Cats', categories: ['A', 'A'] }), /categories/);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM tenants WHERE name IN ('No Cats', 'Dup Cats')");
  assert.equal(rows[0].n, 0);
});

test('a duplicate slug is refused and the first brand is unchanged', async () => {
  const slug = newSlug();
  await createTenant(pool, { slug, name: 'First' });
  await track(slug);
  await assert.rejects(createTenant(pool, { slug, name: 'Second' }), new RegExp(`A brand with slug "${slug}" already exists`));
  assert.deepEqual((await tenantsWithSlug(slug)).map((t) => t.name), ['First']);
});

test('a bad admin leaves no half-made brand behind', async () => {
  const shortPassword = newSlug();
  await assert.rejects(
    createTenant(pool, { slug: shortPassword, name: 'Short Password', admin: { email: newEmail(), password: 'short' } }),
    /password must be at least 10 characters/
  );
  assert.deepEqual(await tenantsWithSlug(shortPassword), []);

  const badEmail = newSlug();
  await assert.rejects(
    createTenant(pool, { slug: badEmail, name: 'Bad Email', admin: { email: 'not-an-email', password: PASSWORD } }),
    /email must look like/
  );
  assert.deepEqual(await tenantsWithSlug(badEmail), []);

  // The email is taken: the unique violation happens after the brand insert, so this checks the rollback.
  const existing = await createAdmin(pool, { email: newEmail(), password: PASSWORD, role: 'super_admin' });
  created.admins.push(existing);
  const taken = newSlug();
  await assert.rejects(
    createTenant(pool, { slug: taken, name: 'Taken Email', admin: { email: existing.email, password: PASSWORD } }),
    /An admin with that email already exists/
  );
  assert.deepEqual(await tenantsWithSlug(taken), []);
  assert.equal((await adminsWithEmail(existing.email)).length, 1);
});

test('npm run tenant:create works from flags, and running it twice changes nothing', async () => {
  const slug = newSlug();
  const email = newEmail();
  const args = ['--slug', slug, '--name', 'Cli Plywood', '--categories', 'Carpenter, Architect', '--admin-email', email];

  const first = await runCli(args, { ADMIN_PASSWORD: PASSWORD });
  await track(slug, email);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`Created brand ${slug} \\(Cli Plywood\\)`));
  assert.match(first.stdout, new RegExp(`/t/${slug}/scan`));
  assert.match(first.stdout, /Categories: {2}Carpenter, Architect/);
  assert.match(first.stdout, new RegExp(`Created tenant_admin ${email}`));

  const second = await runCli(args, { ADMIN_PASSWORD: PASSWORD });
  assert.equal(second.code, 1);
  assert.match(second.stderr, /already exists/);

  const tenants = await tenantsWithSlug(slug);
  assert.equal(tenants.length, 1);
  const admins = await adminsWithEmail(email);
  assert.equal(admins.length, 1);
  assert.equal(admins[0].tenant_id, tenants[0].id);
  const settings = await getSettings(pool, tenants[0].id);
  assert.deepEqual(settings.user_categories, ['Carpenter', 'Architect']);
});

test('the CLI without --name fails clearly', async () => {
  const slug = newSlug();
  const result = await runCli(['--slug', slug]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /A brand name is required/);
  assert.deepEqual(await tenantsWithSlug(slug), []);
});
