const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const { pool, redis } = require('../src/db');
const ledger = require('../src/services/ledger');
const rewards = require('../src/services/rewards');
const users = require('../src/services/users');
const { createTestTenant, destroyTestTenant, createBrowser, randomPhone } = require('./helpers');

const CATEGORIES = ['Carpenter', 'Contractor', 'End User'];
// Every member() logs in from 127.0.0.1, so lift the per-IP OTP limit (10/hour).
const SETTINGS = { user_categories: CATEGORIES, otp_send_limit_per_ip: 1000 };
const DAY = 86400000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);

let server;
let baseUrl;
let tenant;
let otherTenant;

// A logged-in user with a profile, plus their browser.
async function member(t = tenant) {
  const b = createBrowser(baseUrl, t);
  const phone = randomPhone();
  const login = await b.login(phone);
  assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.body)}`);
  await b.post('/profile', { name: 'Member', category: 'Carpenter' });
  const user = await users.findUserByPhone(pool, t.id, `+91${phone}`);
  return { b, user };
}

async function giveCredit(user, amount, { createdDaysAgo = 1, expiresInDays = 59, t = tenant, type = 'scan' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [t.id, user.id, type, amount, daysFromNow(-createdDaysAgo), daysFromNow(expiresInDays)]
  );
  return rows[0].id;
}

async function createReward({ cost = 100, stock = 10, active = true, name = `Reward ${crypto.randomUUID().slice(0, 6)}`, t = tenant } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO rewards (tenant_id, type, name, points_cost, stock, active)
     VALUES ($1, 'voucher', $2, $3, $4, $5) RETURNING id`,
    [t.id, name, cost, stock, active]
  );
  return rows[0].id;
}

function redeem(b, rewardId, key = crypto.randomUUID()) {
  return b.post(`/rewards/${rewardId}/redeem`, {}, { 'Idempotency-Key': key });
}

async function stockOf(rewardId) {
  return (await pool.query('SELECT stock FROM rewards WHERE id = $1', [rewardId])).rows[0].stock;
}

async function balanceOf(user, t = tenant) {
  return ledger.getBalance(pool, t.id, user.id, new Date());
}

async function redemptionCount(user) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM redemptions WHERE user_id = $1', [user.id]);
  return rows[0].n;
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
  tenant = await createTestTenant(pool, 'rewards', SETTINGS);
  otherTenant = await createTestTenant(pool, 'rewards-other', SETTINGS);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await destroyTestTenant(pool, redis, tenant);
  await destroyTestTenant(pool, redis, otherTenant);
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

test('catalog is public, lists only active rewards of this tenant, and hides stock counts', async () => {
  const t = await createTestTenant(pool, 'catalog', { user_categories: CATEGORIES });
  try {
    await createReward({ t, cost: 250, name: 'Trade Pack', stock: 3 });
    await createReward({ t, cost: 100, name: 'Starter', stock: 0 });
    await createReward({ t, cost: 50, name: 'Hidden', active: false });
    await createReward({ t: otherTenant, cost: 10, name: 'Other tenant' });

    const res = await createBrowser(baseUrl, t).get('/rewards');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.rewards.map((r) => [r.name, r.points_cost, r.in_stock]),
      [
        ['Starter', 100, false],
        ['Trade Pack', 250, true]
      ]
    );
    assert.equal(res.body.rewards[0].stock, undefined);
  } finally {
    await destroyTestTenant(pool, redis, t);
  }
});

test('redeem spends the oldest credits first, one debit row per credit', async () => {
  const { b, user } = await member();
  await giveCredit(user, 50, { createdDaysAgo: 70, expiresInDays: -10 }); // expired: skipped
  const oldest = await giveCredit(user, 10, { createdDaysAgo: 30 });
  const spent = await giveCredit(user, 10, { createdDaysAgo: 25 });
  await pool.query(
    `INSERT INTO ledger (tenant_id, user_id, type, amount, consumes_ledger_id, reference_type, reference_id)
     VALUES ($1, $2, 'redeem', -10, $3, 'redemption', $4)`,
    [tenant.id, user.id, spent, crypto.randomUUID()]
  ); // fully spent earlier: skipped
  const middle = await giveCredit(user, 10, { createdDaysAgo: 20 });
  const newest = await giveCredit(user, 20, { createdDaysAgo: 10 });
  const reward = await createReward({ cost: 25 });

  const res = await redeem(b, reward);
  assert.equal(res.status, 201);

  const { rows } = await pool.query(
    `SELECT d.consumes_ledger_id, d.amount
     FROM ledger d JOIN ledger c ON c.id = d.consumes_ledger_id
     WHERE d.reference_id = $1 AND d.type = 'redeem'
     ORDER BY c.created_at`,
    [res.body.redemption.id]
  );
  assert.deepEqual(
    rows.map((r) => [r.consumes_ledger_id, r.amount]),
    [
      [oldest, -10],
      [middle, -10],
      [newest, -5]
    ]
  );
  assert.equal(await balanceOf(user), 15);

  const { activity } = await ledger.getPointsSummary(pool, tenant.id, user.id);
  assert.deepEqual([activity[0].type, activity[0].amount], ['redeem', -25]);
});

test('oldest first means oldest created, even when a newer credit expires sooner', async () => {
  const { b, user } = await member();
  const older = await giveCredit(user, 10, { createdDaysAgo: 30, expiresInDays: 30 });
  await giveCredit(user, 10, { createdDaysAgo: 1, expiresInDays: 2, type: 'adjust' });
  const reward = await createReward({ cost: 10 });

  const res = await redeem(b, reward);
  const { rows } = await pool.query(
    "SELECT consumes_ledger_id FROM ledger WHERE reference_id = $1 AND type = 'redeem'",
    [res.body.redemption.id]
  );
  assert.deepEqual(rows.map((r) => r.consumes_ledger_id), [older]);
});

test('not enough points: 409, and nothing is written', async () => {
  const { b, user } = await member();
  await giveCredit(user, 40);
  const reward = await createReward({ cost: 50, stock: 5 });

  const res = await redeem(b, reward);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'insufficient_points', balance: 40, points_cost: 50 });
  assert.equal(await redemptionCount(user), 0);
  assert.equal(await stockOf(reward), 5);
  assert.equal(await balanceOf(user), 40);
});

test('same idempotency key twice: one redemption, the same voucher returned', async () => {
  const { b, user } = await member();
  await giveCredit(user, 100);
  const reward = await createReward({ cost: 30, stock: 5 });
  const key = crypto.randomUUID();

  const first = await redeem(b, reward, key);
  const second = await redeem(b, reward, key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.redemption.voucher_code, first.body.redemption.voucher_code);

  assert.equal(await redemptionCount(user), 1);
  assert.equal(await balanceOf(user), 70);
  assert.equal(await stockOf(reward), 4);
});

test('double tap: 5 simultaneous requests with one key spend once', async () => {
  const { b, user } = await member();
  await giveCredit(user, 100);
  const reward = await createReward({ cost: 30, stock: 5 });
  const key = crypto.randomUUID();

  const results = await Promise.all(Array.from({ length: 5 }, () => redeem(b, reward, key)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map((r) => r.body.redemption.voucher_code)).size, 1);
  assert.equal(await redemptionCount(user), 1);
  assert.equal(await balanceOf(user), 70);
  assert.equal(await stockOf(reward), 4);
});

test('simultaneous redemptions of different rewards cannot overspend', async () => {
  const { b, user } = await member();
  await giveCredit(user, 50);
  // Different rewards, so only the user lock (not a reward row lock) can
  // stop two of these from spending the same points.
  const rewardIds = [];
  for (let i = 0; i < 5; i++) rewardIds.push(await createReward({ cost: 30, stock: 10 }));

  const results = await Promise.all(rewardIds.map((id) => redeem(b, id)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error === 'insufficient_points'));
  assert.equal(await balanceOf(user), 20);
  assert.equal(await redemptionCount(user), 1);
});

test('an idempotency key cannot be reused by another user or for another reward', async () => {
  const first = await member();
  const second = await member();
  await giveCredit(first.user, 100);
  await giveCredit(second.user, 100);
  const rewardA = await createReward({ cost: 10 });
  const rewardB = await createReward({ cost: 10 });
  const key = crypto.randomUUID();

  assert.equal((await redeem(first.b, rewardA, key)).status, 201);
  const otherUser = await redeem(second.b, rewardA, key);
  assert.equal(otherUser.status, 409);
  assert.equal(otherUser.body.error, 'idempotency_key_conflict');
  const otherReward = await redeem(first.b, rewardB, key);
  assert.equal(otherReward.status, 409);
  assert.equal(await balanceOf(second.user), 100);
});

test('two users racing for the last unit: exactly one gets it', async () => {
  const racers = [await member(), await member()];
  for (const r of racers) await giveCredit(r.user, 100);
  const reward = await createReward({ cost: 10, stock: 1 });

  const results = await Promise.all(racers.map((r) => redeem(r.b, reward)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).body.error, 'out_of_stock');
  assert.equal(await stockOf(reward), 0);
  const balances = await Promise.all(racers.map((r) => balanceOf(r.user)));
  assert.deepEqual(balances.sort(), [100, 90]);
});

test('inactive, unknown, malformed or other-tenant rewards are not found', async () => {
  const { b, user } = await member();
  await giveCredit(user, 100);
  const inactive = await createReward({ cost: 10, active: false });
  const foreign = await createReward({ cost: 10, t: otherTenant });

  for (const id of [inactive, foreign, crypto.randomUUID(), 'not-a-uuid']) {
    const res = await redeem(b, id);
    assert.equal(res.status, 404, `reward ${id}`);
  }
  assert.equal(await balanceOf(user), 100);
});

test('voucher code is readable, unique, and valid for voucher_validity_days', async () => {
  const { b, user } = await member();
  await giveCredit(user, 1000);
  const reward = await createReward({ cost: 10, stock: 50 });

  const codes = new Set();
  for (let i = 0; i < 20; i++) {
    const { body } = await redeem(b, reward);
    assert.match(body.redemption.voucher_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/);
    const validDays =
      (new Date(body.redemption.voucher_expires_at) - new Date(body.redemption.created_at)) / DAY;
    assert.equal(validDays, 30);
    assert.equal(body.redemption.status, 'issued');
    codes.add(body.redemption.voucher_code);
  }
  assert.equal(codes.size, 20);
});

test('cancel refunds the points as a fresh credit, restores stock, and cannot run twice', async () => {
  const { b, user } = await member();
  await giveCredit(user, 40, { createdDaysAgo: 50, expiresInDays: 10 });
  const reward = await createReward({ cost: 30, stock: 2 });
  const { body } = await redeem(b, reward);
  assert.equal(await balanceOf(user), 10);
  assert.equal(await stockOf(reward), 1);

  const adminId = crypto.randomUUID();
  const result = await rewards.cancelRedemption(pool, {
    tenantId: tenant.id,
    redemptionId: body.redemption.id,
    cancelledBy: adminId
  });
  assert.deepEqual(result, { id: body.redemption.id, status: 'cancelled', refunded_points: 30 });
  assert.equal(await balanceOf(user), 40);
  assert.equal(await stockOf(reward), 2);

  const { rows } = await pool.query(
    `SELECT l.amount, l.expires_at, l.created_at, r.status, r.cancelled_by
     FROM ledger l JOIN redemptions r ON r.id = l.reference_id
     WHERE l.reference_id = $1 AND l.type = 'refund'`,
    [body.redemption.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 30);
  assert.equal((rows[0].expires_at - rows[0].created_at) / DAY, 60, 'fresh 60-day expiry');
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].cancelled_by, adminId);

  await assert.rejects(
    rewards.cancelRedemption(pool, { tenantId: tenant.id, redemptionId: body.redemption.id }),
    (e) => e.status === 409 && e.code === 'invalid_status'
  );
  assert.equal(await balanceOf(user), 40, 'no second refund');
});

test('fulfil is final: cannot fulfil twice or cancel afterwards', async () => {
  const { b, user } = await member();
  await giveCredit(user, 50);
  const reward = await createReward({ cost: 20 });
  const { body } = await redeem(b, reward);
  const ids = { tenantId: tenant.id, redemptionId: body.redemption.id };

  assert.deepEqual(await rewards.fulfilRedemption(pool, ids), { id: body.redemption.id, status: 'fulfilled' });
  await assert.rejects(rewards.fulfilRedemption(pool, ids), (e) => e.status === 409);
  await assert.rejects(rewards.cancelRedemption(pool, ids), (e) => e.status === 409);
  assert.equal(await balanceOf(user), 30);

  await assert.rejects(
    rewards.cancelRedemption(pool, { tenantId: otherTenant.id, redemptionId: body.redemption.id }),
    (e) => e.status === 404,
    'another tenant cannot touch it'
  );
});

test('after redeem, cancel and the expiry job, the ledger still adds up', async () => {
  const { b, user } = await member();
  await giveCredit(user, 30, { createdDaysAgo: 40, expiresInDays: 1 });
  await giveCredit(user, 30, { createdDaysAgo: 10 });
  const reward = await createReward({ cost: 40 });
  const first = await redeem(b, reward);
  await redeem(b, reward); // insufficient: 20 left
  await rewards.cancelRedemption(pool, { tenantId: tenant.id, redemptionId: first.body.redemption.id });

  // Two days later the first credit has lapsed (it was fully spent anyway).
  const later = daysFromNow(2);
  await ledger.expireLapsedCredits(pool, tenant.id, later);
  const balance = await ledger.getBalance(pool, tenant.id, user.id, later);
  const { rows } = await pool.query('SELECT SUM(amount)::int AS total FROM ledger WHERE user_id = $1', [user.id]);
  assert.equal(balance, 60);
  assert.equal(rows[0].total, balance);
});

test('GET /redemptions lists only my vouchers, newest first', async () => {
  const me = await member();
  const someoneElse = await member();
  await giveCredit(me.user, 100);
  await giveCredit(someoneElse.user, 100);
  const reward = await createReward({ cost: 10 });

  const first = await redeem(me.b, reward);
  const second = await redeem(me.b, reward);
  await redeem(someoneElse.b, reward);

  const res = await me.b.get('/redemptions');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.redemptions.map((r) => r.voucher_code),
    [second.body.redemption.voucher_code, first.body.redemption.voucher_code]
  );
  assert.equal(res.body.redemptions[0].reward.id, reward);
});

test('redeem and my vouchers require login, a profile, and an idempotency key', async () => {
  const reward = await createReward({ cost: 10 });
  const anon = createBrowser(baseUrl, tenant);
  assert.equal((await redeem(anon, reward)).status, 401);
  assert.equal((await anon.get('/redemptions')).status, 401);

  await anon.login(randomPhone());
  assert.equal((await redeem(anon, reward)).status, 409);

  const { b } = await member();
  const noKey = await b.post(`/rewards/${reward}/redeem`, {});
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, 'missing_idempotency_key');
});
