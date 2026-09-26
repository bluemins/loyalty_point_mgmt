// End-to-end browser test of the user app in two tenant themes.
// Run with: npm run test:e2e   (needs Chromium: npx playwright install chromium)
// Screenshots of every screen are written to screenshots/<theme>/.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = require('../../src/app');
const { pool, redis } = require('../../src/db');
const { createTestTenant, destroyTestTenant, randomPhone } = require('../helpers');

const THEMES = {
  wood: { brand_name: 'Walnut Ply', tagline: 'Trusted plywood for every build', colors: { b1: '#4A2412', b2: '#C8742B', soft: '#FBF3E6' }, hero_texture: 'wood' },
  teal: { brand_name: 'Teal Laminates', tagline: 'Surfaces that last a lifetime', colors: { b1: '#0F3D3E', b2: '#1F8A70', soft: '#EEF7F4' }, hero_texture: 'none' }
};
const SHOTS = path.join(__dirname, '../../screenshots');

let server;
let baseUrl;
let browser;
const tenants = [];

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
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  for (const t of tenants) await destroyTestTenant(pool, redis, t);
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

async function setupTenant(name) {
  const tenant = await createTestTenant(pool, `e2e-${name}`, {
    user_categories: ['Carpenter', 'Contractor', 'End User'],
    ...THEMES[name]
  });
  tenants.push(tenant);
  const rewards = [
    ['Starter Voucher', '10% off your next purchase', 100, null],
    ['Trade Pack', 'Free delivery on a bulk order', 250, '/static/missing-image.jpg'],
    ['Loyalty Bonus', 'Exclusive material credit', 500, null]
  ];
  for (const [rewardName, description, cost, image] of rewards) {
    await pool.query(
      `INSERT INTO rewards (tenant_id, type, name, description, image_url, points_cost, stock, active)
       VALUES ($1, 'voucher', $2, $3, $4, $5, 10, true)`,
      [tenant.id, rewardName, description, image, cost]
    );
  }
  return tenant;
}

for (const theme of Object.keys(THEMES)) {
  test(`full user journey in the ${theme} theme`, async () => {
    const tenant = await setupTenant(theme);
    const dir = path.join(SHOTS, theme);
    fs.mkdirSync(dir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('404')) pageErrors.push(msg.text());
    });
    const shot = (name) => page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });

    // 1. Scan landing: the QR page records the scan and shows pending points.
    await page.goto(`${baseUrl}/t/${tenant.slug}/scan`);
    await page.locator('#scan-points').filter({ hasText: '+10' }).waitFor();
    assert.match(await page.textContent('#landing-title'), /Claim your points/);
    assert.equal(new URL(page.url()).pathname, `/t/${tenant.slug}/`, 'URL no longer /scan');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, hexToRgb(THEMES[theme].colors.soft), 'page uses the tenant soft colour');
    await shot('1-landing');

    // 2. OTP
    await page.click('#landing-cta');
    await page.fill('#phone', randomPhone());
    await page.click('#send-btn');
    await page.locator('#code-form').waitFor();
    await shot('2-otp');
    await page.fill('#code', '000000'); // auto-submits at 6 digits

    // 3. Profile, showing the pending points that will be added
    await page.locator('#screen-profile').waitFor();
    assert.equal(await page.textContent('#profile-pending'), '+10 points will be added');
    await page.fill('#name', 'Ravi Kumar');
    await page.getByRole('button', { name: 'Carpenter' }).click();
    await shot('3-profile');
    await page.click('#profile-form button[type=submit]');

    // 4. Points home with the ring
    await page.locator('#screen-home').waitFor();
    await page.locator('#balance').filter({ hasText: /^10$/ }).waitFor();
    assert.match(await page.textContent('#ring-caption'), /90 more points to Starter Voucher/);
    assert.equal(await page.locator('#activity li').count(), 1);

    // Give the user enough points to redeem, plus some expiring soon.
    const { rows } = await pool.query('SELECT id FROM users WHERE tenant_id = $1', [tenant.id]);
    await pool.query(
      `INSERT INTO ledger (tenant_id, user_id, type, amount, expires_at)
       VALUES ($1, $2, 'adjust', 260, NOW() + interval '60 days'),
              ($1, $2, 'adjust', 30, NOW() + interval '3 days')`,
      [tenant.id, rows[0].id]
    );
    await page.reload();
    await page.locator('#balance').filter({ hasText: /^300$/ }).waitFor();
    assert.equal(await page.isVisible('#expiring-card'), true);
    await shot('4-home');

    // 5. Rewards: the missing image falls back to themed art; unaffordable is disabled.
    await page.click('#go-rewards');
    await page.locator('#rewards-grid .reward').nth(2).waitFor();
    // The image error event fires after load, so wait for the swap.
    await page.waitForFunction(() => document.querySelectorAll('#rewards-grid .reward img').length === 0, null, {
      timeout: 5000
    });
    const buttons = page.locator('#rewards-grid .reward button');
    assert.equal(await buttons.nth(0).textContent(), 'Redeem');
    assert.equal(await buttons.nth(2).isDisabled(), true);
    await shot('5-rewards');

    await buttons.nth(1).click(); // Trade Pack, 250
    await page.locator('#sheet').waitFor();
    assert.match(await page.textContent('#sheet-text'), /You will have 50 left/);
    await shot('6-confirm');
    await page.click('#sheet-confirm');

    // 6. Voucher issued
    await page.locator('#screen-voucher').waitFor();
    const code = await page.textContent('#voucher-code');
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/);
    await shot('7-voucher');

    // My vouchers lists it, and the balance dropped by exactly 250.
    await page.click('#voucher-home');
    await page.locator('#balance').filter({ hasText: /^50$/ }).waitFor();
    await page.click('#go-rewards');
    await page.click('#tab-vouchers');
    await page.locator('#vouchers-list li').first().waitFor();
    assert.match(await page.textContent('#vouchers-list'), new RegExp(code));
    await shot('8-my-vouchers');

    const redemptions = await pool.query('SELECT COUNT(*)::int AS n FROM redemptions WHERE tenant_id = $1', [tenant.id]);
    assert.equal(redemptions.rows[0].n, 1);
    assert.deepEqual(pageErrors, [], 'no JavaScript errors in the page');
    await context.close();
  });
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
