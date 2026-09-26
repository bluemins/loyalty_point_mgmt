const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const { pool, redis } = require('../src/db');
const { tenantApi } = require('../src/routes/admin');
const rewards = require('../src/services/rewards');
const users = require('../src/services/users');
const ledger = require('../src/services/ledger');
const {
  createTestTenant,
  destroyTestTenant,
  createTestAdmin,
  destroyTestAdmins,
  createAdminClient,
  createBrowser,
  randomPhone
} = require('./helpers');

const CATEGORIES = ['Carpenter', 'Contractor', 'End User'];
const DAY = 86400000;

let server;
let baseUrl;
let tenantA;
let tenantB;
let adminA; // tenant_admin of A
let superAdmin;
const admins = [];
const world = {}; // per-tenant ids: { A: { user, redemption, reward }, B: {...} }

async function seedTenant(tenant) {
  const user = await users.createUser(pool, tenant.id, {
    phoneE164: `+91${randomPhone()}`,
    name: 'Seeded User',
    category: 'Carpenter'
  });
  await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, expires_at) VALUES ($1, $2, 'scan', 500, NOW() + interval '60 days')`,
    [tenant.id, user.id]
  );
  const { rows } = await pool.query(
    `INSERT INTO rewards (tenant_id, type, name, points_cost, stock, active)
     VALUES ($1, 'voucher', 'Seeded Voucher', 50, 100, true) RETURNING id`,
    [tenant.id]
  );
  const reward = rows[0].id;
  const { redemption } = await rewards.redeemReward(pool, {
    tenantId: tenant.id,
    userId: user.id,
    rewardId: reward,
    idempotencyKey: crypto.randomUUID()
  });
  return { user: user.id, reward, redemption: redemption.id };
}

// A snapshot of everything an admin could change in a tenant.
async function snapshot(tenant) {
  const q = async (sql) => (await pool.query(sql, [tenant.id])).rows;
  return JSON.stringify({
    settings: await q('SELECT key, value FROM settings WHERE tenant_id = $1 ORDER BY key'),
    rewards: await q('SELECT id, name, points_cost, stock, active FROM rewards WHERE tenant_id = $1 ORDER BY id'),
    ledger: await q('SELECT id FROM ledger WHERE tenant_id = $1 ORDER BY id'),
    redemptions: await q('SELECT id, status FROM redemptions WHERE tenant_id = $1 ORDER BY id'),
    log: await q('SELECT id FROM admin_action_log WHERE tenant_id = $1 ORDER BY id')
  });
}

async function loggedIn(admin) {
  const client = createAdminClient(baseUrl);
  const res = await client.login(admin);
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
  return client;
}

async function logRows(tenant, action) {
  const { rows } = await pool.query(
    'SELECT admin_user_id, entity_id, details FROM admin_action_log WHERE tenant_id = $1 AND action = $2 ORDER BY created_at',
    [tenant.id, action]
  );
  return rows;
}

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
  tenantA = await createTestTenant(pool, 'admin-a', { user_categories: CATEGORIES, otp_send_limit_per_ip: 1000 });
  tenantB = await createTestTenant(pool, 'admin-b', { user_categories: CATEGORIES, otp_send_limit_per_ip: 1000 });
  world.A = await seedTenant(tenantA);
  world.B = await seedTenant(tenantB);
  adminA = await createTestAdmin(pool, { role: 'tenant_admin', tenant: tenantA });
  superAdmin = await createTestAdmin(pool, { role: 'super_admin' });
  admins.push(adminA, superAdmin);

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await redis.del('adm:rl:ip:::ffff:127.0.0.1');
});

after(async () => {
  // Tenants first: their action log rows reference the admins.
  await destroyTestTenant(pool, redis, tenantA);
  await destroyTestTenant(pool, redis, tenantB);
  await destroyTestAdmins(pool, redis, admins);
  await redis.del('adm:rl:ip:::ffff:127.0.0.1');
  // Admin keys are global, so check explicitly that tests left none behind.
  const leftovers = [];
  for await (const key of redis.scanIterator({ MATCH: 'adm:*example.test*' })) leftovers.push(key);
  for (const admin of admins) {
    for await (const key of redis.scanIterator({ MATCH: `adm:sess:${admin.id}:*` })) leftovers.push(key);
  }
  assert.deepEqual(leftovers, [], 'admin Redis keys left behind by tests');
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

// ---------- tenant isolation ----------

// Every tenant-scoped admin route. ids(t) picks the target tenant's ids.
const ENDPOINTS = [
  { method: 'GET', path: '/users' },
  { method: 'GET', path: '/users/:userId' },
  { method: 'POST', path: '/users/:userId/adjust', body: { amount: 10, reason: 'isolation test' } },
  { method: 'GET', path: '/ledger' },
  { method: 'GET', path: '/redemptions' },
  { method: 'POST', path: '/redemptions/:redemptionId/fulfil', body: {} },
  { method: 'POST', path: '/redemptions/:redemptionId/cancel', body: { reason: 'isolation test' } },
  { method: 'GET', path: '/settings' },
  { method: 'PUT', path: '/settings', body: { tagline: 'hacked' } },
  { method: 'GET', path: '/rewards' },
  { method: 'POST', path: '/rewards', body: { name: 'Hacked', points_cost: 1, stock: 1 } },
  { method: 'PUT', path: '/rewards/:rewardId', body: { active: false } }
];

function fill(path, ids) {
  return path
    .replace(':userId', ids.user)
    .replace(':redemptionId', ids.redemption)
    .replace(':rewardId', ids.reward);
}

test('every tenant-scoped admin route is covered by the isolation test', () => {
  const routes = tenantApi.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`))
    .sort();
  const covered = ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort();
  assert.deepEqual(routes, covered, 'add new admin routes to ENDPOINTS in tests/admin.test.js');
});

test("tenant isolation: a tenant admin gets 404 on every route of another tenant, and nothing changes there", async () => {
  const client = await loggedIn(adminA);
  const before = await snapshot(tenantB);

  for (const e of ENDPOINTS) {
    const res = await client.request(e.method, `/t/${tenantB.slug}${fill(e.path, world.B)}`, e.body);
    assert.equal(res.status, 404, `${e.method} ${e.path} on tenant B`);
    assert.deepEqual(res.body, { error: 'tenant_not_found' });
  }
  assert.equal(await snapshot(tenantB), before, 'tenant B unchanged');
});

test("tenant isolation: another tenant's ids under your own slug are not found", async () => {
  const client = await loggedIn(adminA);
  const before = await snapshot(tenantB);

  for (const e of ENDPOINTS.filter((x) => x.path.includes(':'))) {
    const res = await client.request(e.method, `/t/${tenantA.slug}${fill(e.path, world.B)}`, e.body);
    assert.equal(res.status, 404, `${e.method} ${e.path} with tenant B ids`);
  }
  assert.equal(await snapshot(tenantB), before, 'tenant B unchanged');
});

test('a tenant admin only sees their own tenant; a super admin sees all', async () => {
  const a = await (await loggedIn(adminA)).get('/me');
  assert.deepEqual(a.body.tenants.map((t) => t.slug), [tenantA.slug]);
  assert.equal(a.body.role, 'tenant_admin');

  const superClient = await loggedIn(superAdmin);
  const s = await superClient.get('/me');
  const slugs = s.body.tenants.map((t) => t.slug);
  assert.ok(slugs.includes(tenantA.slug) && slugs.includes(tenantB.slug));

  for (const tenant of [tenantA, tenantB]) {
    for (const e of ENDPOINTS.filter((x) => x.method === 'GET')) {
      const res = await superClient.get(`/t/${tenant.slug}${fill(e.path, world[tenant === tenantA ? 'A' : 'B'])}`);
      assert.equal(res.status, 200, `super admin ${e.path} on ${tenant.slug}`);
    }
  }
  assert.equal((await superClient.get('/t/no-such-tenant/users')).status, 404);
});

// ---------- auth ----------

test('login sets a signed, httpOnly, SameSite=Strict cookie limited to /admin', async () => {
  const client = createAdminClient(baseUrl);
  const res = await client.login(adminA);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { email: adminA.email, role: 'tenant_admin', tenants: [{ slug: tenantA.slug, name: 'Test admin-a' }] });
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /^asid=s%3A/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/admin/);
});

test('wrong password and unknown email give the same answer', async () => {
  const wrong = await createAdminClient(baseUrl).login({ email: adminA.email, password: 'not-the-password' });
  const unknown = await createAdminClient(baseUrl).login({ email: 'nobody@example.test', password: 'whatever-123' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.deepEqual(wrong.body, { error: 'invalid_credentials' });
  await redis.del([`adm:rl:email:${adminA.email}`, 'adm:rl:email:nobody@example.test']);
});

test('5 failed logins lock the account, even for the right password', async () => {
  const target = await createTestAdmin(pool, { role: 'tenant_admin', tenant: tenantA });
  admins.push(target);
  for (let i = 0; i < 5; i++) {
    const res = await createAdminClient(baseUrl).login({ email: target.email, password: 'wrong-password' });
    assert.equal(res.status, 401);
  }
  const locked = await createAdminClient(baseUrl).login(target);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, 'too_many_attempts');
  assert.ok(locked.body.retry_after_seconds > 0 && locked.body.retry_after_seconds <= 15 * 60);

  // Emails are matched case-insensitively, so case changes do not dodge the lock.
  const upper = await createAdminClient(baseUrl).login({ email: target.email.toUpperCase(), password: target.password });
  assert.equal(upper.status, 429);

  await redis.del(`adm:rl:email:${target.email}`);
  assert.equal((await createAdminClient(baseUrl).login(target)).status, 200, 'works again after the window');
});

test('logout revokes the session on the server', async () => {
  const client = await loggedIn(adminA);
  const copied = { ...client.jar };
  await client.post('/logout');

  const replay = createAdminClient(baseUrl);
  Object.assign(replay.jar, copied);
  assert.equal((await replay.get('/me')).status, 401);
});

test('a deleted admin is locked out at once', async () => {
  const temp = await createTestAdmin(pool, { role: 'tenant_admin', tenant: tenantA });
  const client = await loggedIn(temp);
  assert.equal((await client.get('/me')).status, 200);
  // Delete only the account; the Redis session still exists.
  await pool.query('DELETE FROM admin_users WHERE id = $1', [temp.id]);
  assert.equal((await client.get('/me')).status, 401);
  await destroyTestAdmins(pool, redis, [temp]); // removes the leftover session key
});

test('user and admin sessions never cross over', async () => {
  const user = createBrowser(baseUrl, tenantA);
  await user.login(randomPhone());
  await user.post('/profile', { name: 'Crossover', category: 'Carpenter' });
  const withUserCookie = createAdminClient(baseUrl);
  Object.assign(withUserCookie.jar, user.jar);
  assert.equal((await withUserCookie.get('/me')).status, 401, 'user cookie on admin API');

  const adminClient = await loggedIn(adminA);
  const withAdminCookie = createBrowser(baseUrl, tenantA);
  Object.assign(withAdminCookie.jar, adminClient.jar);
  assert.equal((await withAdminCookie.get('/points')).status, 401, 'admin cookie on user API');
});

test('changes must be sent as JSON', async () => {
  const client = await loggedIn(adminA);
  const res = await client.request('PUT', `/t/${tenantA.slug}/settings`, undefined, { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);
});

// ---------- users, ledger, adjustments ----------

test('users list shows balances and searches by phone or name', async () => {
  const client = await loggedIn(adminA);
  const phone = randomPhone();
  const user = await users.createUser(pool, tenantA.id, { phoneE164: `+91${phone}`, name: 'Findable Farhan', category: 'Contractor' });
  await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, expires_at) VALUES ($1, $2, 'scan', 70, NOW() + interval '5 days'),
            ($1, $2, 'scan', 30, NOW() - interval '1 day')`,
    [tenantA.id, user.id]
  );

  const byPhone = await client.get(`/t/${tenantA.slug}/users?q=${phone.slice(-6)}`);
  assert.deepEqual(byPhone.body.items.map((u) => [u.name, u.balance]), [['Findable Farhan', 70]]);
  const byName = await client.get(`/t/${tenantA.slug}/users?q=farhan`);
  assert.equal(byName.body.items.length, 1);
  const wildcard = await client.get(`/t/${tenantA.slug}/users?q=%25`);
  assert.equal(wildcard.body.items.length, 0, 'a literal % does not match everything');

  const detail = await client.get(`/t/${tenantA.slug}/users/${user.id}`);
  assert.equal(detail.body.balance, 70);
  assert.equal(detail.body.ledger.length, 2);
});

test('adjust: add points, remove oldest first, never below zero, always logged', async () => {
  const client = await loggedIn(adminA);
  const user = await users.createUser(pool, tenantA.id, { phoneE164: `+91${randomPhone()}`, name: 'Adjusted', category: 'Carpenter' });
  const path = `/t/${tenantA.slug}/users/${user.id}/adjust`;

  const add = await client.post(path, { amount: 50, reason: 'goodwill for late delivery' });
  assert.deepEqual(add.body, { amount: 50, balance: 50 });
  const remove = await client.post(path, { amount: -20, reason: 'duplicate credit' });
  assert.deepEqual(remove.body, { amount: -20, balance: 30 });

  const tooMuch = await client.post(path, { amount: -31, reason: 'too much' });
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.error, 'insufficient_points');

  assert.equal((await client.post(path, { amount: 0, reason: 'zero' })).status, 400);
  assert.equal((await client.post(path, { amount: 1.5, reason: 'fraction' })).status, 400);
  assert.equal((await client.post(path, { amount: 5 })).status, 400, 'reason required');

  const { rows } = await pool.query(
    `SELECT type, amount, consumes_ledger_id IS NOT NULL AS is_debit FROM ledger WHERE user_id = $1 ORDER BY created_at, amount`,
    [user.id]
  );
  assert.deepEqual(rows.map((r) => [r.type, r.amount, r.is_debit]), [
    ['adjust', 50, false],
    ['adjust', -20, true]
  ]);
  const logs = (await logRows(tenantA, 'points.adjust')).filter((l) => l.entity_id === user.id);
  assert.deepEqual(logs.map((l) => [l.admin_user_id, l.details.amount, l.details.reason]), [
    [adminA.id, 50, 'goodwill for late delivery'],
    [adminA.id, -20, 'duplicate credit']
  ]);
});

test('ledger can be filtered by type and user', async () => {
  const client = await loggedIn(adminA);
  const res = await client.get(`/t/${tenantA.slug}/ledger?type=redeem&user=${world.A.user}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 1);
  assert.ok(res.body.items.every((r) => r.type === 'redeem' && r.user_id === world.A.user));
});

// ---------- redemptions ----------

async function freshRedemption(tenant) {
  const user = await users.createUser(pool, tenant.id, { phoneE164: `+91${randomPhone()}`, name: 'Voucher User', category: 'Carpenter' });
  await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, expires_at) VALUES ($1, $2, 'scan', 100, NOW() + interval '60 days')`,
    [tenant.id, user.id]
  );
  const { redemption } = await rewards.redeemReward(pool, {
    tenantId: tenant.id,
    userId: user.id,
    rewardId: world.A.reward,
    idempotencyKey: crypto.randomUUID()
  });
  return { user, redemption };
}

test('fulfil and cancel through the admin API, both logged', async () => {
  const client = await loggedIn(adminA);
  const one = await freshRedemption(tenantA);
  const two = await freshRedemption(tenantA);

  const fulfilled = await client.post(`/t/${tenantA.slug}/redemptions/${one.redemption.id}/fulfil`);
  assert.deepEqual(fulfilled.body, { id: one.redemption.id, status: 'fulfilled' });

  assert.equal((await client.post(`/t/${tenantA.slug}/redemptions/${two.redemption.id}/cancel`, {})).status, 400, 'reason required');
  const cancelled = await client.post(`/t/${tenantA.slug}/redemptions/${two.redemption.id}/cancel`, { reason: 'out of stock at store' });
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(await ledger.getBalance(pool, tenantA.id, two.user.id, new Date()), 100);

  assert.ok((await logRows(tenantA, 'redemption.fulfil')).some((l) => l.entity_id === one.redemption.id));
  const cancelLog = (await logRows(tenantA, 'redemption.cancel')).find((l) => l.entity_id === two.redemption.id);
  assert.equal(cancelLog.details.reason, 'out of stock at store');

  const list = await client.get(`/t/${tenantA.slug}/redemptions?status=cancelled`);
  assert.ok(list.body.items.every((r) => r.status === 'cancelled'));
  assert.ok(list.body.items.some((r) => r.id === two.redemption.id));
});

test('vouchers past their date read as expired, cannot be used, and the job marks them', async () => {
  const client = await loggedIn(adminA);
  const { user, redemption } = await freshRedemption(tenantA);
  // Move the voucher's validity into the past.
  await pool.query("UPDATE redemptions SET voucher_expires_at = NOW() - interval '1 minute' WHERE id = $1", [redemption.id]);

  const listed = await client.get(`/t/${tenantA.slug}/redemptions?status=expired`);
  assert.ok(listed.body.items.some((r) => r.id === redemption.id), 'shown as expired before the job runs');

  const fulfil = await client.post(`/t/${tenantA.slug}/redemptions/${redemption.id}/fulfil`);
  assert.equal(fulfil.status, 409);
  assert.deepEqual(fulfil.body, { error: 'invalid_status', status: 'expired' });
  const cancel = await client.post(`/t/${tenantA.slug}/redemptions/${redemption.id}/cancel`, { reason: 'try refund' });
  assert.equal(cancel.status, 409, 'expired is final, no refund');

  const marked = await rewards.expireVouchers(pool, tenantA.id);
  assert.ok(marked >= 1);
  const { rows } = await pool.query('SELECT status, expired_at FROM redemptions WHERE id = $1', [redemption.id]);
  assert.equal(rows[0].status, 'expired');
  assert.ok(rows[0].expired_at);
  assert.equal(await rewards.expireVouchers(pool, tenantA.id), 0, 'running again changes nothing');

  const mine = await rewards.listRedemptions(pool, tenantA.id, user.id);
  assert.equal(mine[0].status, 'expired', 'the user sees it as expired too');
  assert.equal(await ledger.getBalance(pool, tenantA.id, user.id, new Date()), 50, 'no refund (100 - 50)');
});

// ---------- settings ----------

test('settings: validated, logged with before/after, and applied to the app', async () => {
  const client = await loggedIn(adminA);
  const path = `/t/${tenantA.slug}/settings`;

  const current = await client.get(path);
  assert.equal(current.status, 200);
  assert.ok(!current.body.editable.includes('msg91_sender_id'), 'tenant admin cannot edit MSG91');
  assert.ok(current.body.editable.includes('points_per_scan'));

  const ok = await client.put(path, { points_per_scan: 15, colors: { b1: '#112233', b2: '#445566', soft: '#FAFAFA' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.changed.sort(), ['colors', 'points_per_scan']);
  assert.equal(ok.body.settings.points_per_scan, 15);

  const log = (await logRows(tenantA, 'settings.update')).at(-1);
  assert.deepEqual(log.details.points_per_scan, { from: 10, to: 15 });

  const page = await (await fetch(`${baseUrl}/t/${tenantA.slug}/`)).text();
  assert.ok(page.includes('--b1: #112233'), 'new colours on the user app');

  const unchanged = await client.put(path, { points_per_scan: 15 });
  assert.deepEqual(unchanged.body.changed, [], 'no-op writes nothing');

  const bad = [
    [{ colors: { b1: 'red', b2: '#445566', soft: '#FAFAFA' } }, 400, 'invalid_setting'],
    [{ points_per_scan: -1 }, 400, 'invalid_setting'],
    [{ user_categories: [] }, 400, 'invalid_setting'],
    [{ user_categories: ['A', 'A'] }, 400, 'invalid_setting'],
    [{ logo_url: 'javascript:alert(1)' }, 400, 'invalid_setting'],
    [{ hero_texture: 'marble' }, 400, 'invalid_setting'],
    [{ not_a_setting: 1 }, 400, 'unknown_setting'],
    [{ msg91_sender_id: 'ABCDEF' }, 403, 'forbidden_setting'],
    [{ otp_send_limit_per_ip: 999 }, 403, 'forbidden_setting'],
    [{}, 400, 'invalid_settings']
  ];
  for (const [body, status, error] of bad) {
    const res = await client.put(path, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.body.error, error, JSON.stringify(body));
  }

  const superClient = await loggedIn(superAdmin);
  const msg = await superClient.put(path, { msg91_sender_id: 'BLUMNS' });
  assert.equal(msg.status, 200, 'super admin can edit MSG91');
  await superClient.put(path, { points_per_scan: 10 });
});

// ---------- rewards ----------

test('rewards: create, edit, deactivate; public catalog follows; all logged', async () => {
  const client = await loggedIn(adminA);
  const created = await client.post(`/t/${tenantA.slug}/rewards`, {
    name: 'Drill Set',
    description: 'Cordless drill voucher',
    points_cost: 400,
    stock: 3
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'voucher');
  assert.equal(created.body.active, true);

  const catalog = async () => (await (await fetch(`${baseUrl}/t/${tenantA.slug}/rewards`)).json()).rewards.map((r) => r.name);
  assert.ok((await catalog()).includes('Drill Set'));

  const edited = await client.put(`/t/${tenantA.slug}/rewards/${created.body.id}`, { points_cost: 350, active: false });
  assert.equal(edited.body.points_cost, 350);
  assert.ok(!(await catalog()).includes('Drill Set'), 'inactive rewards leave the catalog');

  const all = await client.get(`/t/${tenantA.slug}/rewards`);
  assert.ok(all.body.rewards.some((r) => r.id === created.body.id && r.stock === 3), 'admin still sees it, with stock');

  for (const body of [{ name: '', points_cost: 1, stock: 1 }, { name: 'X', points_cost: 0, stock: 1 }, { name: 'X', points_cost: 1, stock: 1, type: 'product' }]) {
    assert.equal((await client.post(`/t/${tenantA.slug}/rewards`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await client.put(`/t/${tenantA.slug}/rewards/${created.body.id}`, {})).status, 400);

  assert.ok((await logRows(tenantA, 'reward.create')).some((l) => l.entity_id === created.body.id));
  const update = (await logRows(tenantA, 'reward.update')).find((l) => l.entity_id === created.body.id);
  assert.deepEqual(update.details.points_cost, { from: 400, to: 350 });
});

test('the admin page is served', async () => {
  const res = await fetch(`${baseUrl}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('settings editor shows effective values for keys a tenant never set, and saves only what changed', async () => {
  const bare = await createTestTenant(pool, 'admin-bare', {});
  const bareAdmin = await createTestAdmin(pool, { role: 'tenant_admin', tenant: bare });
  try {
    const client = await loggedIn(bareAdmin);
    const { body } = await client.get(`/t/${bare.slug}/settings`);
    assert.deepEqual(body.settings.colors, { b1: '#1F2937', b2: '#4B5563', soft: '#F9FAFB' }, 'same defaults as the app');
    assert.equal(body.settings.brand_name, 'Test admin-bare');
    assert.equal(body.settings.tagline, '');
    assert.deepEqual(body.settings.user_categories, []);

    // Sending the shown values back unchanged is a no-op.
    const echo = await client.put(`/t/${bare.slug}/settings`, {
      colors: body.settings.colors,
      brand_name: body.settings.brand_name,
      tagline: body.settings.tagline
    });
    assert.deepEqual(echo.body.changed, []);
  } finally {
    await destroyTestTenant(pool, redis, bare);
    await destroyTestAdmins(pool, redis, [bareAdmin]);
  }
});
