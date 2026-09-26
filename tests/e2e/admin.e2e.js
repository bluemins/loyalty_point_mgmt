// End-to-end browser test of the admin panel.
// Run with: npm run test:e2e   Screenshots go to screenshots/admin/.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = require('../../src/app');
const { pool, redis } = require('../../src/db');
const rewards = require('../../src/services/rewards');
const users = require('../../src/services/users');
const { createTestTenant, destroyTestTenant, createTestAdmin, destroyTestAdmins, randomPhone } = require('../helpers');

const SHOTS = path.join(__dirname, '../../screenshots/admin');

let server;
let baseUrl;
let browser;
let tenant;
let other;
let tenantAdmin;
let superAdmin;
let user;
let redemptionId;

before(async () => {
  await redis.connect();
  app.locals.db = pool;
  app.locals.redis = redis;
  tenant = await createTestTenant(pool, 'e2e-admin', { user_categories: ['Carpenter', 'Contractor'], brand_name: 'Walnut Ply' });
  other = await createTestTenant(pool, 'e2e-admin-other', { user_categories: ['Carpenter'] });

  user = await users.createUser(pool, tenant.id, { phoneE164: `+91${randomPhone()}`, name: 'Ravi Kumar', category: 'Carpenter' });
  await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, expires_at) VALUES ($1, $2, 'scan', 300, NOW() + interval '60 days')`,
    [tenant.id, user.id]
  );
  const { rows } = await pool.query(
    `INSERT INTO rewards (tenant_id, type, name, points_cost, stock, active) VALUES ($1, 'voucher', 'Trade Pack', 250, 5, true) RETURNING id`,
    [tenant.id]
  );
  ({ redemption: { id: redemptionId } } = await rewards.redeemReward(pool, {
    tenantId: tenant.id,
    userId: user.id,
    rewardId: rows[0].id,
    idempotencyKey: crypto.randomUUID()
  }));

  tenantAdmin = await createTestAdmin(pool, { role: 'tenant_admin', tenant });
  superAdmin = await createTestAdmin(pool, { role: 'super_admin' });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  fs.mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await destroyTestTenant(pool, redis, tenant);
  await destroyTestTenant(pool, redis, other);
  await destroyTestAdmins(pool, redis, [tenantAdmin, superAdmin]);
  await redis.del('adm:rl:ip:::ffff:127.0.0.1');
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

async function openPage(viewport = { width: 1280, height: 860 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401|404|409/.test(m.text())) errors.push(m.text());
  });
  return { context, page, errors };
}

async function login(page, admin) {
  await page.goto(`${baseUrl}/admin`);
  await page.fill('#login-email', admin.email);
  await page.fill('#login-password', admin.password);
  await page.click('#login-form button[type=submit]');
  await page.locator('#shell').waitFor();
}

test('tenant admin: login, users, adjust, fulfil, settings, rewards', async () => {
  const { context, page, errors } = await openPage();
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

  // Login: a wrong password shows an error first.
  await page.goto(`${baseUrl}/admin`);
  await page.fill('#login-email', tenantAdmin.email);
  await page.fill('#login-password', 'wrong-password');
  await page.click('#login-form button[type=submit]');
  await page.locator('#login-error').filter({ hasText: 'Wrong email or password' }).waitFor();
  await shot('1-login');
  await redis.del(`adm:rl:email:${tenantAdmin.email}`);
  await login(page, tenantAdmin);
  assert.equal(await page.isVisible('#tenant-select'), false, 'one tenant: no switcher');

  // Users list, then detail with an adjustment.
  await page.locator('td', { hasText: 'Ravi Kumar' }).waitFor();
  await shot('2-users');
  await page.click('text=Ravi Kumar');
  // The first stat is the balance; match it exactly (the phone stat has digits too).
  const balance = page.locator('.stat').first().locator('strong');
  await balance.filter({ hasText: /^50$/ }).waitFor();
  await page.fill('input[aria-label=Points]', '25');
  await page.fill('input[aria-label=Reason]', 'Goodwill for delayed delivery');
  await page.getByRole('button', { name: 'Adjust points' }).click();
  await balance.filter({ hasText: /^75$/ }).waitFor();
  await shot('3-user-detail');

  // Redemptions: fulfil through the confirm dialog.
  await page.click('#nav a[data-view=redemptions]');
  await page.locator('td.code').first().waitFor();
  await shot('4-redemptions');
  await page.click('button:has-text("Fulfil")');
  await page.locator('#dialog[open]').waitFor();
  await shot('5-fulfil-dialog');
  await page.click('#dialog-ok');
  await page.locator('td.empty', { hasText: 'No redemptions' }).waitFor();
  const { rows } = await pool.query('SELECT status FROM redemptions WHERE id = $1', [redemptionId]);
  assert.equal(rows[0].status, 'fulfilled');

  // Settings: MSG91 locked for a tenant admin; saving the tagline works.
  await page.click('#nav a[data-view=settings]');
  await page.getByRole('button', { name: 'Save settings' }).waitFor();
  assert.equal(await page.locator('.field', { hasText: 'Sender ID' }).locator('input').isDisabled(), true);
  const tagline = page.locator('.field', { hasText: 'Tagline' }).locator('input');
  await tagline.fill('Plywood you can trust');
  await shot('6-settings');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.locator('#toast', { hasText: /^Saved: tagline$/ }).waitFor(); // only what was edited
  const setting = await pool.query("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'tagline'", [tenant.id]);
  assert.equal(setting.rows[0].value, 'Plywood you can trust');

  // Rewards: create one through the dialog.
  await page.click('#nav a[data-view=rewards]');
  await page.getByRole('button', { name: 'New reward' }).click();
  await page.locator('#dialog[open]').waitFor();
  const dialog = page.locator('#dialog');
  await dialog.locator('label', { hasText: 'Name' }).locator('input').fill('Drill Set');
  await dialog.locator('label', { hasText: 'Points cost' }).locator('input').fill('400');
  await dialog.locator('label', { hasText: 'Stock' }).locator('input').fill('3');
  await page.click('#dialog-ok');
  await page.locator('td', { hasText: 'Drill Set' }).waitFor();
  await shot('7-rewards');

  // Ledger shows the adjustment.
  await page.click('#nav a[data-view=ledger]');
  await page.locator('td', { hasText: 'adjust' }).first().waitFor();
  await shot('8-ledger');

  const logged = await pool.query('SELECT action FROM admin_action_log WHERE tenant_id = $1 ORDER BY created_at', [tenant.id]);
  assert.deepEqual(logged.rows.map((r) => r.action), ['points.adjust', 'redemption.fulfil', 'settings.update', 'reward.create']);
  assert.deepEqual(errors, [], 'no JavaScript errors');
  await context.close();
});

test('super admin: tenant switcher and phone-sized layout', async () => {
  const { context, page, errors } = await openPage({ width: 390, height: 844 });
  await login(page, superAdmin);
  assert.equal(await page.isVisible('#tenant-select'), true);
  const options = await page.locator('#tenant-select option').allTextContents();
  assert.ok(options.includes('Walnut Ply') || options.includes('Test e2e-admin'));
  await page.selectOption('#tenant-select', other.slug);
  await page.locator('td.empty', { hasText: 'No users found' }).waitFor();
  assert.match(page.url(), new RegExp(`#/${other.slug}/users`));
  await page.screenshot({ path: path.join(SHOTS, '9-super-admin-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
