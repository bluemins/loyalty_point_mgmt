const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const { pool, redis } = require('../src/db');
const ledger = require('../src/services/ledger');
const users = require('../src/services/users');
const {
  createTestTenant,
  setSettings,
  destroyTestTenant,
  createBrowser,
  randomPhone
} = require('./helpers');

const CATEGORIES = ['Carpenter', 'Contractor', 'End User'];
const DAY = 86400000;
const NOW = new Date('2026-06-15T12:00:00+05:30');
const at = (days, from = NOW) => new Date(from.getTime() + days * DAY);

let server;
let baseUrl;
let tenantA;
let tenantB;

async function newUser(tenant) {
  return users.createUser(pool, tenant.id, {
    phoneE164: `+91${randomPhone()}`,
    name: 'Ledger User',
    category: 'Carpenter'
  });
}

// Tests write ledger rows directly to set up exact histories.
async function credit(tenant, user, amount, { expiresAt, createdAt = at(-1), type = 'scan' }) {
  const { rows } = await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenant.id, user.id, type, amount, expiresAt, createdAt]
  );
  return rows[0].id;
}

async function debit(tenant, user, creditId, amount, { ref = crypto.randomUUID(), createdAt = NOW, type = 'redeem' } = {}) {
  await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, consumes_ledger_id, reference_type, reference_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'redemption', $6, $7)`,
    [tenant.id, user.id, type, amount, creditId, ref, createdAt]
  );
}

async function ledgerRows(tenant, user) {
  const { rows } = await pool.query(
    `SELECT type, amount, consumes_ledger_id, tenant_id FROM ledger
     WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at`,
    [tenant.id, user.id]
  );
  return rows;
}

async function ledgerSum(tenant, user) {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(amount), 0)::int AS total FROM ledger WHERE tenant_id = $1 AND user_id = $2',
    [tenant.id, user.id]
  );
  return rows[0].total;
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

  tenantA = await createTestTenant(pool, 'ledger-a', { user_categories: CATEGORIES, scan_cooldown_minutes: 0 });
  tenantB = await createTestTenant(pool, 'ledger-b', { user_categories: CATEGORIES });

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await destroyTestTenant(pool, redis, tenantA);
  await destroyTestTenant(pool, redis, tenantB);
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

test('balance is what is left of unexpired credits', async () => {
  const user = await newUser(tenantA);
  await credit(tenantA, user, 10, { expiresAt: at(-1) }); // lapsed yesterday
  const partlySpent = await credit(tenantA, user, 10, { expiresAt: at(30) });
  await credit(tenantA, user, 20, { expiresAt: at(3) });
  await debit(tenantA, user, partlySpent, -5);

  assert.equal(await ledger.getBalance(pool, tenantA.id, user.id, NOW), 25);
  // Two days earlier the first credit had not lapsed yet.
  assert.equal(await ledger.getBalance(pool, tenantA.id, user.id, at(-2)), 35);
});

test('a lapsed credit leaves the balance at its expiry time, before the nightly job runs', async () => {
  const user = await newUser(tenantA);
  const expiresAt = at(0);
  await credit(tenantA, user, 10, { expiresAt });

  assert.equal(await ledger.getBalance(pool, tenantA.id, user.id, new Date(expiresAt.getTime() - 1000)), 10);
  assert.equal(await ledger.getBalance(pool, tenantA.id, user.id, expiresAt), 0);
  assert.equal((await ledgerRows(tenantA, user)).length, 1, 'no expire row yet');
});

test('expiry job writes exactly what is left of each lapsed credit, and is safe to re-run', async () => {
  // Own tenant, so the job's totals only reflect this test's data.
  const t = await createTestTenant(pool, 'ledger-expiry', { user_categories: CATEGORIES });
  try {
    const user = await newUser(t);
    const partly = await credit(t, user, 10, { expiresAt: at(-1) });
    await debit(t, user, partly, -4);
    const fully = await credit(t, user, 10, { expiresAt: at(-2) });
    await debit(t, user, fully, -10);
    await credit(t, user, 10, { expiresAt: at(10) });

    const balanceBefore = await ledger.getBalance(pool, t.id, user.id, NOW);
    assert.equal(balanceBefore, 10);

    const first = await ledger.expireLapsedCredits(pool, t.id, NOW);
    assert.deepEqual(first, { users: 1, credits: 1, points: 6 });

    const expireRows = (await ledgerRows(t, user)).filter((r) => r.type === 'expire');
    assert.equal(expireRows.length, 1, 'fully spent credit gets no expire row');
    assert.equal(expireRows[0].amount, -6);
    assert.equal(expireRows[0].consumes_ledger_id, partly);

    assert.equal(await ledger.getBalance(pool, t.id, user.id, NOW), balanceBefore, 'balance unchanged by job');
    assert.equal(await ledgerSum(t, user), balanceBefore, 'after the job, ledger sum equals balance');

    const second = await ledger.expireLapsedCredits(pool, t.id, NOW);
    assert.deepEqual(second, { users: 0, credits: 0, points: 0 });
    assert.equal((await ledgerRows(t, user)).length, 6);
  } finally {
    await destroyTestTenant(pool, redis, t);
  }
});

test('two expiry runs at the same time still expire each credit once', async () => {
  const user = await newUser(tenantB);
  await credit(tenantB, user, 10, { expiresAt: at(-1) });
  await credit(tenantB, user, 7, { expiresAt: at(-3) });

  const [a, b] = await Promise.all([
    ledger.expireLapsedCredits(pool, tenantB.id, NOW),
    ledger.expireLapsedCredits(pool, tenantB.id, NOW)
  ]);
  assert.equal(a.points + b.points, 17);
  const expired = (await ledgerRows(tenantB, user)).filter((r) => r.type === 'expire');
  assert.equal(expired.length, 2);
  assert.equal(await ledgerSum(tenantB, user), 0);
});

test('expiry job only touches the tenant it runs for', async () => {
  const userA = await newUser(tenantA);
  const userB = await newUser(tenantB);
  await credit(tenantA, userA, 10, { expiresAt: at(-1) });
  await credit(tenantB, userB, 10, { expiresAt: at(-1) });

  await ledger.expireLapsedCredits(pool, tenantA.id, NOW);
  assert.equal((await ledgerRows(tenantA, userA)).filter((r) => r.type === 'expire').length, 1);
  assert.equal((await ledgerRows(tenantB, userB)).filter((r) => r.type === 'expire').length, 0);

  await ledger.expireLapsedCredits(pool, tenantB.id, NOW);
  const rowsB = await ledgerRows(tenantB, userB);
  assert.ok(rowsB.every((r) => r.tenant_id === tenantB.id));
});

test('expiring soon groups unspent points by IST date within the configured window', async () => {
  const tenant = await createTestTenant(pool, 'ledger-soon', { user_categories: CATEGORIES });
  try {
    const user = await newUser(tenant);
    // 23:30 UTC on the 17th is 05:00 IST on the 18th: grouped under the 18th.
    await credit(tenant, user, 10, { expiresAt: new Date('2026-06-17T23:30:00Z') });
    await credit(tenant, user, 5, { expiresAt: new Date('2026-06-18T20:00:00+05:30') });
    const spent = await credit(tenant, user, 10, { expiresAt: at(4) });
    await debit(tenant, user, spent, -10);
    await credit(tenant, user, 7, { expiresAt: at(8) });

    const summary = await ledger.getPointsSummary(pool, tenant.id, user.id, NOW);
    assert.deepEqual(summary.expiring_soon, {
      total: 15,
      within_days: 7,
      by_date: [{ date: '2026-06-18', points: 15 }]
    });

    await setSettings(pool, tenant, { expiring_soon_days: 10 });
    const wider = await ledger.getPointsSummary(pool, tenant.id, user.id, NOW);
    assert.equal(wider.expiring_soon.total, 22);
    assert.deepEqual(wider.expiring_soon.by_date.map((d) => d.date), ['2026-06-18', '2026-06-23']);
  } finally {
    await destroyTestTenant(pool, redis, tenant);
  }
});

test('activity lists credits one by one and groups a split debit into one event', async () => {
  const user = await newUser(tenantA);
  const first = await credit(tenantA, user, 10, { expiresAt: at(30), createdAt: at(-3) });
  const second = await credit(tenantA, user, 10, { expiresAt: at(31), createdAt: at(-2) });
  const ref = crypto.randomUUID();
  await debit(tenantA, user, first, -10, { ref, createdAt: at(-1) });
  await debit(tenantA, user, second, -5, { ref, createdAt: at(-1) });

  const { activity } = await ledger.getPointsSummary(pool, tenantA.id, user.id, NOW);
  assert.deepEqual(
    activity.map((a) => [a.type, a.amount]),
    [
      ['redeem', -15],
      ['scan', 10],
      ['scan', 10]
    ]
  );
  assert.equal(activity[0].expires_at, null);
  assert.ok(activity[1].expires_at instanceof Date);
});

test('ledger is append-only: direct UPDATE and DELETE are rejected', async () => {
  const user = await newUser(tenantA);
  const id = await credit(tenantA, user, 10, { expiresAt: at(30) });

  await assert.rejects(pool.query('UPDATE ledger SET amount = 999 WHERE id = $1', [id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ledger WHERE id = $1', [id]), /append-only/);
  assert.equal((await ledgerRows(tenantA, user))[0].amount, 10);
});

test('deleting a user or tenant still removes their ledger rows (cascade is allowed)', async () => {
  const tenant = await createTestTenant(pool, 'ledger-cascade', { user_categories: CATEGORIES });
  const user = await newUser(tenant);
  const other = await newUser(tenant);
  const id = await credit(tenant, user, 10, { expiresAt: at(30) });
  await debit(tenant, user, id, -3);
  await credit(tenant, other, 10, { expiresAt: at(30) });

  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  assert.equal((await ledgerRows(tenant, user)).length, 0);
  assert.equal((await ledgerRows(tenant, other)).length, 1);

  // destroyTestTenant asserts nothing is left, including the ledger.
  await destroyTestTenant(pool, redis, tenant);
});

test('ledger rows must be a dated credit or a debit that names its credit', async () => {
  const user = await newUser(tenantA);
  await assert.rejects(
    pool.query(`INSERT INTO ledger (tenant_id, user_id, type, amount) VALUES ($1, $2, 'scan', 10)`, [
      tenantA.id,
      user.id
    ]),
    /ledger_credit_debit_shape/,
    'credit without expires_at'
  );
  await assert.rejects(
    pool.query(`INSERT INTO ledger (tenant_id, user_id, type, amount) VALUES ($1, $2, 'redeem', -5)`, [
      tenantA.id,
      user.id
    ]),
    /ledger_credit_debit_shape/,
    'debit without consumes_ledger_id'
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO ledger (tenant_id, user_id, type, amount, expires_at) VALUES ($1, $2, 'adjust', 0, NOW())`,
      [tenantA.id, user.id]
    ),
    /ledger_credit_debit_shape/,
    'zero amount'
  );
});

test('GET /points: 401 without login, 409 before profile, then the real summary', async () => {
  const b = createBrowser(baseUrl, tenantA);
  assert.equal((await b.get('/points')).status, 401);

  await b.login(randomPhone());
  const noProfile = await b.get('/points');
  assert.equal(noProfile.status, 409);
  assert.equal(noProfile.body.error, 'needs_profile');

  await b.post('/profile', { name: 'Kiran', category: 'Carpenter' });
  await b.scan();
  await b.scan();

  const res = await b.get('/points');
  assert.equal(res.status, 200);
  assert.equal(res.body.balance, 20);
  assert.deepEqual(res.body.expiring_soon, { total: 0, within_days: 7, by_date: [] });
  assert.deepEqual(
    res.body.activity.map((a) => [a.type, a.amount]),
    [
      ['scan', 10],
      ['scan', 10]
    ]
  );
});

test('GET /points: a session from one tenant cannot read another tenant', async () => {
  const inA = createBrowser(baseUrl, tenantA);
  await inA.login(randomPhone());
  await inA.post('/profile', { name: 'Nisha', category: 'Carpenter' });
  await inA.scan();
  assert.equal((await inA.get('/points')).body.balance, 10);

  const inB = createBrowser(baseUrl, tenantB);
  Object.assign(inB.jar, inA.jar);
  const res = await inB.get('/points');
  assert.equal(res.status, 401);
});
