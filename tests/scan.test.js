const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const { pool, redis } = require('../src/db');
const { MOCK_OTP } = require('../src/services/msg91');
const scans = require('../src/services/scans');
const users = require('../src/services/users');

const CATEGORIES = ['Carpenter', 'Contractor', 'End User'];
const IST = '+05:30';
const deps = { db: pool, redis };

let server;
let baseUrl;
let tenantSlow; // default rules: 10 min cooldown, cap 5
let tenantFast; // no cooldown, so cap and merge tests can scan back to back
let tenantOther; // for isolation checks

async function createTenant(label, settings = {}) {
  const slug = `test-${label}-${crypto.randomBytes(4).toString('hex')}`;
  const { rows } = await pool.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug',
    [slug, `Test ${label}`]
  );
  await setSettings(rows[0], { user_categories: CATEGORIES, ...settings });
  return rows[0];
}

async function setSettings(tenant, settings) {
  for (const [key, value] of Object.entries(settings)) {
    await pool.query(
      `INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [tenant.id, key, JSON.stringify(value)]
    );
  }
}

async function clearRedisFor(tenant) {
  for await (const key of redis.scanIterator({ MATCH: `*:${tenant.id}:*` })) {
    await redis.del(key);
  }
}

// A minimal browser: keeps cookies between requests to one tenant.
function browser(tenant) {
  const jar = {};
  return {
    jar,
    async post(path, body = {}) {
      const res = await fetch(`${baseUrl}/t/${tenant.slug}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
        },
        body: JSON.stringify(body)
      });
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        jar[name] = value;
      }
      return { status: res.status, body: await res.json() };
    },
    scan() {
      return this.post('/scan');
    },
    async login(phone) {
      await this.post('/otp/send', { phone });
      return this.post('/otp/verify', { phone, otp: MOCK_OTP });
    }
  };
}

function randomPhone() {
  return `9${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
}

function randomDevice() {
  return crypto.randomBytes(16).toString('hex');
}

async function newUser(tenant) {
  return users.createUser(pool, tenant.id, {
    phoneE164: `+91${randomPhone()}`,
    name: 'Test User',
    category: 'Carpenter'
  });
}

async function ledgerFor(tenant, userId) {
  const { rows } = await pool.query(
    `SELECT type, amount, expires_at, created_at FROM ledger
     WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, amount`,
    [tenant.id, userId]
  );
  return rows;
}

before(async () => {
  await redis.connect();
  app.locals.db = pool;
  app.locals.redis = redis;
  // Never reach MSG91 from tests, even if .env has a real key.
  app.locals.msg91 = {
    authKey: '',
    fetchImpl: async () => {
      throw new Error('Tests must not call MSG91');
    }
  };

  tenantSlow = await createTenant('slow');
  tenantFast = await createTenant('fast', { scan_cooldown_minutes: 0 });
  tenantOther = await createTenant('other', { scan_cooldown_minutes: 0 });

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  for (const t of [tenantSlow, tenantFast, tenantOther]) await clearRedisFor(t);
});

after(async () => {
  for (const t of [tenantSlow, tenantFast, tenantOther]) await clearRedisFor(t);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [
    [tenantSlow.id, tenantFast.id, tenantOther.id]
  ]);
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

test('anonymous scan holds points as pending and issues a device cookie', async () => {
  const b = browser(tenantSlow);
  const res = await b.scan();

  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'pending');
  assert.equal(res.body.points, 10);
  assert.equal(res.body.pending_points, 10);
  assert.match(res.body.message, /pending/);
  assert.match(b.jar.dt, /^s%3A/, 'device cookie is signed');
});

test('cooldown: a second scan within 10 minutes earns nothing and does not restart the timer', async () => {
  const b = browser(tenantSlow);
  await b.scan();
  const key = `scan:cd:${tenantSlow.id}:*`;
  const [cdKey] = await redis.keys(key);
  const ttlBefore = await redis.pTTL(cdKey);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const res = await b.scan();

  assert.equal(res.body.outcome, 'cooldown');
  assert.equal(res.body.points, 0);
  assert.equal(res.body.pending_points, 10, 'still only the first scan pending');
  assert.ok(res.body.retry_after_seconds > 590 && res.body.retry_after_seconds <= 600);
  assert.match(res.body.message, /try again in 10 minutes/);
  assert.ok((await redis.pTTL(cdKey)) < ttlBefore, 'refused scan did not reset the cooldown');

  const { rows } = await pool.query(
    "SELECT outcome FROM scan_events WHERE tenant_id = $1 AND outcome = 'cooldown'",
    [tenantSlow.id]
  );
  assert.ok(rows.length >= 1, 'refused scan is still logged');
});

test('cooldown cannot be bypassed by logging in right after an anonymous scan', async () => {
  const b = browser(tenantSlow);
  assert.equal((await b.scan()).body.outcome, 'pending');
  await b.login(randomPhone());
  const profile = await b.post('/profile', { name: 'Vijay', category: 'Carpenter' });
  assert.equal(profile.body.merged_points, 10);

  const res = await b.scan();
  assert.equal(res.body.outcome, 'cooldown');
  assert.equal(res.body.points, 0);
});

test('daily cap: an anonymous device gets 5 pending scans, the 6th is capped', async () => {
  const b = browser(tenantFast);
  for (let i = 1; i <= 5; i++) {
    assert.equal((await b.scan()).body.outcome, 'pending');
  }
  const res = await b.scan();
  assert.equal(res.body.outcome, 'capped');
  assert.equal(res.body.pending_points, 50);
  assert.match(res.body.message, /today's scan limit/);
});

test('daily cap: a logged-in user gets 5 credited scans, the 6th is capped', async () => {
  const b = browser(tenantFast);
  const phone = randomPhone();
  await b.login(phone);
  await b.post('/profile', { name: 'Ravi', category: 'Carpenter' });

  for (let i = 1; i <= 5; i++) {
    const res = await b.scan();
    assert.equal(res.body.outcome, 'credited');
    assert.equal(res.body.pending_points, undefined);
  }
  assert.equal((await b.scan()).body.outcome, 'capped');

  const user = await users.findUserByPhone(pool, tenantFast.id, `+91${phone}`);
  const ledger = await ledgerFor(tenantFast, user.id);
  assert.equal(ledger.length, 5);
  assert.ok(ledger.every((row) => row.type === 'scan' && row.amount === 10));
});

test('daily cap resets at midnight IST, not UTC', async () => {
  const device = randomDevice();
  const scan = (now) =>
    scans.recordScan(deps, { tenant: tenantFast, deviceHash: device, now: new Date(now) });

  for (let i = 0; i < 5; i++) {
    assert.equal((await scan(`2026-03-10T23:50:00${IST}`)).outcome, 'pending');
  }
  assert.equal((await scan(`2026-03-10T23:59:00${IST}`)).outcome, 'capped');
  // 00:01 IST is still the previous day in UTC, but a new scan day here.
  assert.equal((await scan(`2026-03-11T00:01:00${IST}`)).outcome, 'pending');
});

test('new user: verify asks for a profile, then the profile claims pending points', async () => {
  const b = browser(tenantFast);
  await b.scan();
  await b.scan();

  const verify = await b.login(randomPhone());
  assert.equal(verify.body.needs_profile, true);
  assert.equal(verify.body.pending_points, 20);

  const bad = await b.post('/profile', { name: 'Ravi', category: 'Astronaut' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_category');
  assert.deepEqual(bad.body.categories, CATEGORIES);

  const profile = await b.post('/profile', { name: '  Ravi Kumar ', category: 'Contractor' });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.merged_points, 20);
  assert.equal(profile.body.user.name, 'Ravi Kumar');

  const again = await b.post('/profile', { name: 'Ravi', category: 'Contractor' });
  assert.equal(again.status, 409);

  // Points are in the ledger with a 60-day expiry, and new scans credit directly.
  const user = await users.findUserByPhone(pool, tenantFast.id, profile.body.user.phone);
  const ledger = await ledgerFor(tenantFast, user.id);
  assert.equal(ledger.length, 2);
  const days = (ledger[0].expires_at - ledger[0].created_at) / 86400000;
  assert.equal(days, 60);

  assert.equal((await b.scan()).body.outcome, 'credited');
});

test('profile requires a verified session', async () => {
  const res = await browser(tenantFast).post('/profile', { name: 'X', category: 'Carpenter' });
  assert.equal(res.status, 401);
});

test('existing user: verify merges pending points, and the same scans never merge twice', async () => {
  const phone = randomPhone();
  const first = browser(tenantFast);
  await first.login(phone);
  await first.post('/profile', { name: 'Asha', category: 'End User' });

  // Same person on a new phone handset, scanning before logging in.
  const second = browser(tenantFast);
  await second.scan();
  const verify = await second.login(phone);
  assert.equal(verify.body.needs_profile, false);
  assert.equal(verify.body.merged_points, 10);

  await second.post('/logout');
  const again = await second.login(phone);
  assert.equal(again.body.merged_points, 0);

  const user = await users.findUserByPhone(pool, tenantFast.id, `+91${phone}`);
  assert.equal((await ledgerFor(tenantFast, user.id)).length, 1);
});

test('pending points older than pending_points_ttl_days are not merged', async () => {
  await setSettings(tenantOther, { pending_points_ttl_days: 30 });
  const user = await newUser(tenantOther);
  const device = randomDevice();
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000);

  await scans.recordScan(deps, { tenant: tenantOther, deviceHash: device, now: daysAgo(31) });
  await scans.recordScan(deps, { tenant: tenantOther, deviceHash: device, now: daysAgo(29) });

  const merged = await scans.mergePending(deps, {
    tenant: tenantOther,
    userId: user.id,
    deviceHash: device,
    now
  });
  assert.equal(merged.credited, 1);
  assert.equal(merged.points, 10);
});

test('merge applies the daily cap per scan day across devices', async () => {
  const user = await newUser(tenantFast);
  const deviceA = randomDevice();
  const deviceB = randomDevice();
  const at = (t) => new Date(t);

  // Day 1: device A already brought 4 credited scans for this user.
  for (let i = 0; i < 4; i++) {
    await scans.recordScan(deps, { tenant: tenantFast, deviceHash: deviceA, now: at(`2026-04-01T10:00:00${IST}`) });
  }
  await scans.mergePending(deps, { tenant: tenantFast, userId: user.id, deviceHash: deviceA, now: at(`2026-04-01T12:00:00${IST}`) });

  // Device B: 3 scans on day 1 (only 1 fits under the cap) and 3 on day 2 (all fit).
  for (let i = 0; i < 3; i++) {
    await scans.recordScan(deps, { tenant: tenantFast, deviceHash: deviceB, now: at(`2026-04-01T11:00:00${IST}`) });
    await scans.recordScan(deps, { tenant: tenantFast, deviceHash: deviceB, now: at(`2026-04-02T11:00:00${IST}`) });
  }
  const merged = await scans.mergePending(deps, {
    tenant: tenantFast,
    userId: user.id,
    deviceHash: deviceB,
    now: at(`2026-04-02T12:00:00${IST}`)
  });

  assert.deepEqual(merged, { points: 40, credited: 4, capped: 2 });
  assert.equal((await ledgerFor(tenantFast, user.id)).length, 8);
});

test('merged scans from today count toward the live daily cap', async () => {
  const phone = randomPhone();
  const b = browser(tenantFast);
  for (let i = 0; i < 3; i++) await b.scan();
  await b.login(phone);
  await b.post('/profile', { name: 'Meena', category: 'Carpenter' });

  assert.equal((await b.scan()).body.outcome, 'credited');
  assert.equal((await b.scan()).body.outcome, 'credited');
  assert.equal((await b.scan()).body.outcome, 'capped', '3 merged + 2 live = cap of 5');
});

test('tenant isolation: pending scans in one tenant never merge into another', async () => {
  const phone = randomPhone();
  const inFast = browser(tenantFast);
  await inFast.scan();

  // Replay tenant A's device cookie against tenant B.
  const inOther = browser(tenantOther);
  Object.assign(inOther.jar, inFast.jar);
  const verify = await inOther.login(phone);
  assert.equal(verify.body.pending_points, 0);
  const profile = await inOther.post('/profile', { name: 'Isha', category: 'Carpenter' });
  assert.equal(profile.body.merged_points, 0);

  // The scan is still pending in tenant A.
  const stillPending = await inFast.login(randomPhone());
  assert.equal(stillPending.body.pending_points, 10);
});

test('settings changes apply to future scans only', async () => {
  const device = randomDevice();
  const user = await newUser(tenantOther);
  await setSettings(tenantOther, { points_per_scan: 10 });
  await scans.recordScan(deps, { tenant: tenantOther, deviceHash: device });

  await setSettings(tenantOther, { points_per_scan: 25 });
  const second = await scans.recordScan(deps, { tenant: tenantOther, deviceHash: device });
  assert.equal(second.points, 25);

  const merged = await scans.mergePending(deps, { tenant: tenantOther, userId: user.id, deviceHash: device });
  assert.equal(merged.points, 35, 'first scan keeps its original 10 points');
  await setSettings(tenantOther, { points_per_scan: 10 });
});

test('unknown fields in the scan request do not change points', async () => {
  const b = browser(tenantFast);
  const res = await b.post('/scan', { points: 1000, user_id: 'x' });
  assert.equal(res.body.points, 10);
});
