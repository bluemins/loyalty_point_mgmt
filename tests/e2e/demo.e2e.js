// End-to-end walkthrough of everything the brand admin presentation shows
// (the slide deck and docs/DEMO_SCRIPT.md), in the same order: a customer on a
// phone and the brand admin on a computer, side by side.
//   npm run test:demo              headless, screenshots in screenshots/demo/
//   HEADED=1 npm run test:demo     opens the browsers so you can watch it
// It uses its own throwaway brands and admins; the demo brand is never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = require('../../src/app');
const { pool, redis } = require('../../src/db');
const { createTestTenant, destroyTestTenant, createTestAdmin, destroyTestAdmins, randomPhone } = require('../helpers');

const SHOTS = path.join(__dirname, '../../screenshots/demo');
const HEADED = Boolean(process.env.HEADED);
const WOOD = { b1: '#4A2412', b2: '#C8742B', soft: '#FBF3E6' };
const CATEGORIES = ['Carpenter', 'Contractor', 'End User'];

let server;
let baseUrl;
let browser;
let brand;
let otherBrand;
let brandAdmin;
let superAdmin;
let customer; // { context, page, errors }
let admin;
const phone = randomPhone();
let step = 0;

before(async () => {
  await redis.connect();
  app.locals.db = pool;
  app.locals.redis = redis;
  app.locals.msg91 = {
    authKey: '',
    fetchImpl: async () => {
      throw new Error('Tests must not call MSG91');
    }
  };
  brand = await createTestTenant(pool, 'demo-walk', {
    user_categories: CATEGORIES,
    brand_name: 'Demo Plywood',
    tagline: 'Trusted materials for every build',
    colors: WOOD,
    hero_texture: 'wood'
  });
  otherBrand = await createTestTenant(pool, 'demo-walk-other', {
    user_categories: CATEGORIES,
    brand_name: 'Other Laminates',
    colors: { b1: '#0F3D3E', b2: '#1F8A70', soft: '#EEF7F4' }
  });
  for (const [name, cost, stock] of [['Starter Voucher', 100, 20], ['Trade Pack', 250, 10], ['Loyalty Bonus', 500, 5]]) {
    await pool.query(
      `INSERT INTO rewards (tenant_id, type, name, description, points_cost, stock, active)
       VALUES ($1, 'voucher', $2, 'Demo reward', $3, $4, true)`,
      [brand.id, name, cost, stock]
    );
  }
  brandAdmin = await createTestAdmin(pool, { role: 'tenant_admin', tenant: brand });
  superAdmin = await createTestAdmin(pool, { role: 'super_admin' });

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 250 : 0 });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  customer = await openWindow({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  admin = await openWindow({ viewport: { width: 1280, height: 860 } });
});

after(async () => {
  await browser?.close();
  await destroyTestTenant(pool, redis, brand);
  await destroyTestTenant(pool, redis, otherBrand);
  await destroyTestAdmins(pool, redis, [brandAdmin, superAdmin]);
  await redis.del('adm:rl:ip:::ffff:127.0.0.1');
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

async function openWindow(options) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Expected API refusals (400/422 validation, 401 before login, 404 isolation, 409, 429 lockout) log as console errors.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/400|401|404|409|422|429/.test(m.text())) errors.push(m.text());
  });
  return { context, page, errors };
}

function shot(page, name) {
  step += 1;
  return page.screenshot({ path: path.join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
}

const appUrl = (tenant = brand) => `${baseUrl}/t/${tenant.slug}`;

// Opening the QR URL is a scan. Resolves with the landing title.
async function scan(page, tenant = brand) {
  await page.goto(`${appUrl(tenant)}/scan`);
  const title = page.locator('#landing-title').filter({ hasText: /Claim your points|Points added|scanned recently|all for today/ });
  await title.waitFor();
  return title.textContent();
}

async function openHome(expectedBalance) {
  const { page } = customer;
  // A goto that only changes the #hash would not reload, so leave the page first.
  await page.goto('about:blank');
  await page.goto(`${appUrl()}/#home`);
  await page.locator('#screen-home').waitFor();
  await page.locator('#balance').filter({ hasText: new RegExp(`^${expectedBalance}$`) }).waitFor();
}

async function adminLogin(page, who, password = who.password) {
  await page.goto(`${baseUrl}/admin`);
  await page.fill('#login-email', who.email);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type=submit]');
}

async function adminNav(view) {
  await admin.page.click(`#nav a[data-view=${view}]`);
}

async function saveSettings(changes) {
  const { page } = admin;
  await adminNav('settings');
  await page.getByRole('button', { name: 'Save settings' }).waitFor();
  for (const [label, value] of Object.entries(changes)) {
    await page.locator('.field', { hasText: label }).locator('input').first().fill(value);
  }
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.locator('#toast', { hasText: /^Saved: / }).waitFor();
}

async function openCustomerInAdmin() {
  const { page } = admin;
  await adminNav('users');
  await page.fill('input[type=search]', phone.slice(-5));
  await page.getByRole('button', { name: 'Search' }).click();
  await page.locator('td', { hasText: 'Ravi Kumar' }).click();
  return page.locator('.stat').first().locator('strong');
}

async function adjust(amount, reason) {
  const { page } = admin;
  await page.fill('input[aria-label=Points]', String(amount));
  await page.fill('input[aria-label=Reason]', reason);
  await page.getByRole('button', { name: 'Adjust points' }).click();
}

async function redeemStarterVoucher() {
  const { page } = customer;
  await page.click('#go-rewards');
  await page.locator('#rewards-grid .reward').nth(2).waitFor();
  await page.locator('#rewards-grid .reward button').nth(0).click();
  await page.locator('#sheet').waitFor();
  await page.click('#sheet-confirm');
  await page.locator('#screen-voucher').waitFor();
  return page.textContent('#voucher-code');
}

async function starterStock() {
  const { rows } = await pool.query("SELECT stock FROM rewards WHERE tenant_id = $1 AND name = 'Starter Voucher'", [brand.id]);
  return rows[0].stock;
}

// ---------- Slides "Four steps" and "What your customers see" ----------

test('slide: a customer scans, verifies and earns', async () => {
  const { page } = customer;
  assert.equal(await scan(page), 'Claim your points');
  assert.match(await page.textContent('#scan-points'), /\+10/);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(251, 243, 230)', 'wood theme loaded from theme.css');
  await shot(page, 'customer-scan-pending');

  // Scanning again straight away is refused and does not add pending points.
  assert.equal(await scan(page), 'You scanned recently');
  await shot(page, 'customer-scan-cooldown');

  await page.click('#landing-cta');
  await page.fill('#phone', phone);
  await page.click('#send-btn');
  await page.locator('#code-form').waitFor();
  await page.fill('#code', '123456');
  await page.locator('#code-error').filter({ hasText: 'Wrong code. 4 attempts left.' }).waitFor();
  await shot(page, 'customer-wrong-code');
  await page.fill('#code', '000000');

  await page.locator('#screen-profile').waitFor();
  assert.equal(await page.textContent('#profile-pending'), '+10 points will be added');
  await page.fill('#name', 'Ravi Kumar');
  await page.getByRole('button', { name: 'Carpenter' }).click();
  await page.click('#profile-form button[type=submit]');
  await page.locator('#screen-home').waitFor();
  await page.locator('#balance').filter({ hasText: /^10$/ }).waitFor();
  await shot(page, 'customer-home');
});

// ---------- Slide "One login, five screens" ----------

test('slide: the brand admin signs in and sees only their brand', async () => {
  const { page } = admin;
  await adminLogin(page, brandAdmin, 'wrong-password');
  await page.locator('#login-error').filter({ hasText: 'Wrong email or password' }).waitFor();
  await redis.del(`adm:rl:email:${brandAdmin.email}`);

  await adminLogin(page, brandAdmin);
  await page.locator('#shell').waitFor();
  assert.equal(await page.isVisible('#tenant-select'), false, 'no brand switcher for a tenant admin');
  await page.locator('td', { hasText: 'Ravi Kumar' }).waitFor();
  await shot(page, 'admin-users');
});

// ---------- Slide "Scans that earn nothing" (daily limit) ----------

test('slide: five earning scans a day, then the daily limit', async () => {
  await saveSettings({ 'Cooldown (minutes)': '0' });

  const { page } = customer;
  for (let i = 2; i <= 5; i += 1) assert.equal(await scan(page), 'Points added!', `scan ${i}`);
  assert.equal(await scan(page), "That's all for today");
  await shot(page, 'customer-daily-limit');
  await openHome(50);

  await saveSettings({ 'Cooldown (minutes)': '10' });
  const { rows } = await pool.query(
    'SELECT outcome, COUNT(*)::int AS n FROM scan_events WHERE tenant_id = $1 GROUP BY outcome ORDER BY outcome',
    [brand.id]
  );
  assert.deepEqual(rows, [
    { outcome: 'capped', n: 1 },
    { outcome: 'cooldown', n: 1 },
    { outcome: 'credited', n: 5 } // the first scan was pending, then claimed at sign-up
  ]);
});

// ---------- Slide "Users and point adjustments" ----------

test('slide: find the customer and adjust points', async () => {
  const { page } = admin;
  const balance = await openCustomerInAdmin();
  await balance.filter({ hasText: /^50$/ }).waitFor();

  await adjust(100, '');
  await page.locator('p.error', { hasText: 'Please give a reason' }).waitFor();
  await adjust(-1000, 'Too much');
  await page.locator('p.error', { hasText: 'does not have enough points' }).waitFor();
  await adjust(100, 'Welcome bonus');
  await page.locator('#toast', { hasText: 'Adjusted by +100. New balance 150' }).waitFor();
  await balance.filter({ hasText: /^150$/ }).waitFor();
  await shot(page, 'admin-user-adjusted');

  await openHome(150);
  assert.match(await customer.page.textContent('#activity'), /Adjustment/);
});

// ---------- Slide "At the counter: fulfil or cancel" ----------

test('slide: the customer redeems and the admin fulfils', async () => {
  const code = await redeemStarterVoucher();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/);
  await shot(customer.page, 'customer-voucher');
  await openHome(50);
  assert.equal(await starterStock(), 19);

  const { page } = admin;
  await adminNav('redemptions');
  await page.locator('td.code', { hasText: code }).waitFor();
  await shot(page, 'admin-redemptions');
  await page.click('button:has-text("Fulfil")');
  await page.locator('#dialog[open]').waitFor();
  await page.click('#dialog-ok');
  await page.locator('#toast', { hasText: 'Marked as fulfilled' }).waitFor();
  const { rows } = await pool.query('SELECT status FROM redemptions WHERE voucher_code = $1 AND tenant_id = $2', [code, brand.id]);
  assert.equal(rows[0].status, 'fulfilled');
});

test('slide: cancelling refunds the points as a new batch and restores stock', async () => {
  await openCustomerInAdmin();
  await adjust(100, 'Points for the cancel demo');
  await admin.page.locator('#toast', { hasText: 'New balance 150' }).waitFor();

  await openHome(150);
  const code = await redeemStarterVoucher();
  await openHome(50);
  assert.equal(await starterStock(), 18); // 20, minus the fulfilled voucher and this one

  const { page } = admin;
  await adminNav('redemptions');
  await page.locator('td.code', { hasText: code }).waitFor();
  await page.click('button:has-text("Cancel")');
  await page.locator('#dialog[open]').waitFor();
  await page.locator('#dialog label', { hasText: 'Reason' }).locator('input').fill('Out of stock at store');
  await shot(page, 'admin-cancel-dialog');
  await page.click('#dialog-ok');
  await page.locator('#toast', { hasText: 'Cancelled. 100 points refunded' }).waitFor();

  assert.equal(await starterStock(), 19);
  const refund = await pool.query(
    `SELECT amount, ROUND(EXTRACT(EPOCH FROM expires_at - created_at) / 86400)::int AS days
     FROM ledger WHERE tenant_id = $1 AND type = 'refund'`,
    [brand.id]
  );
  assert.deepEqual(refund.rows, [{ amount: 100, days: 60 }]);

  await openHome(150);
  await customer.page.click('#go-rewards');
  await customer.page.click('#tab-vouchers');
  await customer.page.locator('#vouchers-list li').nth(1).waitFor();
  const statuses = await customer.page.locator('#vouchers-list .status').allTextContents();
  assert.deepEqual(statuses.sort(), ['cancelled', 'fulfilled']);
  await shot(customer.page, 'customer-my-vouchers');
});

// ---------- Slides "Balance" and "Worked example": the ledger ----------

test('slide: the ledger shows every movement', async () => {
  const { page } = admin;
  await adminNav('ledger');
  await page.selectOption('select[aria-label=Type]', 'redeem');
  await page.locator('td', { hasText: 'redeem' }).first().waitFor();
  const types = await page.locator('tbody tr td:nth-child(3)').allTextContents();
  assert.ok(types.length > 0 && types.every((t) => t === 'redeem'), `only redeem rows: ${types}`);
  await shot(page, 'admin-ledger-redeem');

  const { rows } = await pool.query(
    'SELECT type, SUM(amount)::int AS total FROM ledger WHERE tenant_id = $1 GROUP BY type ORDER BY type',
    [brand.id]
  );
  assert.deepEqual(rows, [
    { type: 'adjust', total: 200 },
    { type: 'redeem', total: -200 },
    { type: 'refund', total: 100 },
    { type: 'scan', total: 50 }
  ]);
});

// ---------- Slide "Settings apply from now on" ----------

test('slide: branding changes show in the app at once; SMS settings are locked', async () => {
  const { page } = admin;
  await adminNav('settings');
  await page.getByRole('button', { name: 'Save settings' }).waitFor();
  assert.equal(await page.locator('.field', { hasText: 'Sends per phone' }).locator('input').isDisabled(), true);
  assert.equal(await page.locator('.field', { hasText: 'Sender ID' }).locator('input').isDisabled(), true);

  await page.locator('.field', { hasText: 'Tagline' }).locator('input').fill('Plywood you can trust');
  await page.locator('.field', { hasText: 'Colours' }).locator('input[type=color]').nth(2).fill('#f4ead8');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.locator('#toast', { hasText: /^Saved: tagline, colors$/ }).waitFor();
  await shot(page, 'admin-settings-saved');

  await openHome(150);
  assert.equal(await customer.page.textContent('.tagline'), 'Plywood you can trust');
  const bg = await customer.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(244, 234, 216)', 'new soft colour served by theme.css');
  await shot(customer.page, 'customer-new-branding');
});

// ---------- Slide "Four steps" note: brands are separate ----------

test('slide: another brand cannot be reached, and the same phone there is a new account', async () => {
  const res = await admin.page.request.get(`${baseUrl}/admin/api/t/${otherBrand.slug}/users`);
  assert.equal(res.status(), 404);
  assert.deepEqual(await res.json(), { error: 'tenant_not_found' });

  const other = await openWindow({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    assert.equal(await scan(other.page, otherBrand), 'Claim your points');
    await other.page.click('#landing-cta');
    await other.page.fill('#phone', phone);
    await other.page.click('#send-btn');
    await other.page.locator('#code-form').waitFor();
    await other.page.fill('#code', '000000');
    await other.page.locator('#screen-profile').waitFor(); // a new account: asked for a profile again
    await shot(other.page, 'other-brand-new-account');
    assert.deepEqual(other.errors, []);
  } finally {
    await other.context.close();
  }

  const superWindow = await openWindow({ viewport: { width: 1280, height: 860 } });
  try {
    await adminLogin(superWindow.page, superAdmin);
    await superWindow.page.locator('#shell').waitFor();
    // The switcher lists brands by their tenant name.
    const options = await superWindow.page.locator('#tenant-select option').allTextContents();
    const { rows } = await pool.query('SELECT name FROM tenants WHERE id = ANY($1) ORDER BY name', [[brand.id, otherBrand.id]]);
    for (const { name } of rows) assert.ok(options.includes(name), `${name} in switcher: ${options}`);
    await shot(superWindow.page, 'super-admin-switcher');
    assert.deepEqual(superWindow.errors, []);
  } finally {
    await superWindow.context.close();
  }
});

// ---------- Slide "Your routine and getting help": lockout ----------

test('slide: five wrong passwords lock the account until unlocked', async () => {
  const lockout = await openWindow({ viewport: { width: 1280, height: 860 } });
  try {
    const { page } = lockout;
    for (let i = 0; i < 5; i += 1) {
      await adminLogin(page, brandAdmin, 'wrong-password');
      await page.locator('#login-error').filter({ hasText: 'Wrong email or password' }).waitFor();
    }
    await adminLogin(page, brandAdmin);
    await page.locator('#login-error').filter({ hasText: 'Too many failed attempts' }).waitFor();
    await shot(page, 'admin-locked-out');

    await redis.del(`adm:rl:email:${brandAdmin.email}`); // what the platform owner's unlock command does
    await adminLogin(page, brandAdmin);
    await page.locator('#shell').waitFor();
  } finally {
    await lockout.context.close();
  }
});

test('every admin change was recorded, and no page had a JavaScript error', async () => {
  const { rows } = await pool.query('SELECT action FROM admin_action_log WHERE tenant_id = $1 ORDER BY created_at', [brand.id]);
  assert.deepEqual(
    rows.map((r) => r.action),
    [
      'settings.update',
      'settings.update',
      'points.adjust',
      'redemption.fulfil',
      'points.adjust',
      'redemption.cancel',
      'settings.update'
    ]
  );
  assert.deepEqual(customer.errors, [], 'customer window');
  assert.deepEqual(admin.errors, [], 'admin window');
});
