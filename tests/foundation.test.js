const test = require('node:test');
const crypto = require('crypto');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { env } = require('../src/config/env');
const { pool, redis, pingServices } = require('../src/db');
const { seed } = require('../src/db/seed');
const { TENANT_TABLES, destroyTestTenant } = require('./helpers');

function listen(appInstance) {
  return new Promise((resolve, reject) => {
    const server = appInstance.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });

    server.on('error', reject);
  });
}

async function ensureDatabaseAvailable() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureRedisAvailable() {
  try {
    if (!redis.isOpen) {
      await redis.connect();
    }
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (error) {
    return false;
  }
}

test('env configuration loads with required values', () => {
  assert.equal(typeof env.APP_NAME, 'string');
  assert.ok(env.APP_NAME.length > 0);
  assert.ok(env.DATABASE_URL.includes('postgresql://'));
  assert.ok(env.REDIS_URL.includes('redis://'));
  assert.equal(typeof env.SESSION_SECRET, 'string');
});

test('root route responds with service metadata', async () => {
  const { server, port } = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.service, env.APP_NAME);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('health route returns degraded status when DB and Redis are not connected yet', async () => {
  const { server, port } = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.equal(data.status, 'degraded');
    assert.equal(data.database, false);
    assert.equal(data.redis, false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('PostgreSQL connectivity is available when the local service is running', async (t) => {
  const available = await ensureDatabaseAvailable();

  if (!available) {
    t.skip('PostgreSQL is not running locally; skipping DB connectivity test.');
    return;
  }

  const result = await pool.query('SELECT 1 AS ok');
  assert.equal(result.rows[0].ok, 1);
});

test('Redis connectivity is available when the local service is running', async (t) => {
  const available = await ensureRedisAvailable();

  if (!available) {
    t.skip('Redis is not running locally; skipping Redis connectivity test.');
    return;
  }

  const pong = await redis.ping();
  assert.equal(pong, 'PONG');

  if (redis.isOpen) {
    await redis.quit();
  }
});

test('migration execution creates the required base tables', async (t) => {
  const available = await ensureDatabaseAvailable();

  if (!available) {
    t.skip('PostgreSQL is not running locally; skipping migration test.');
    return;
  }

  await pool.query('CREATE TABLE IF NOT EXISTS _foundation_test_marker (id INT);');

  const result = await pool.query(
    `SELECT to_regclass('public.tenants') AS tenants_exists,
            to_regclass('public.settings') AS settings_exists,
            to_regclass('public.users') AS users_exists,
            to_regclass('public.rewards') AS rewards_exists`
  );

  const row = result.rows[0];
  assert.equal(row.tenants_exists, 'tenants');
  assert.equal(row.settings_exists, 'settings');
  assert.equal(row.users_exists, 'users');
  assert.equal(row.rewards_exists, 'rewards');

  await pool.query('DROP TABLE IF EXISTS _foundation_test_marker;');
});

test('seed is idempotent: running it twice gives one tenant, 3 rewards, no duplicates', async (t) => {
  if (!(await ensureDatabaseAvailable())) {
    t.skip('PostgreSQL is not running locally; skipping seed test.');
    return;
  }
  if (!redis.isOpen) await redis.connect();

  // A throwaway slug, so the test never touches the demo tenant's data.
  const slug = `test-seed-${crypto.randomBytes(4).toString('hex')}`;
  const first = await seed({ slug, name: 'Seed Test' });
  const countRows = async (table) =>
    Number((await pool.query(`SELECT COUNT(*) FROM ${table} WHERE tenant_id = $1`, [first.id])).rows[0].count);
  const settingsAfterFirst = await countRows('settings');

  const second = await seed({ slug, name: 'Seed Test' });

  try {
    assert.equal(second.id, first.id, 'same tenant reused');
    assert.equal(await countRows('rewards'), 3, 'exactly 3 rewards after two runs');
    assert.equal(await countRows('settings'), settingsAfterFirst, 'no extra settings rows');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM tenants WHERE slug = $1', [slug]);
    assert.equal(rows[0].n, 1);
  } finally {
    await destroyTestTenant(pool, redis, first);
    await redis.quit();
  }
});

test('test cleanup covers every table that has tenant_id', async (t) => {
  if (!(await ensureDatabaseAvailable())) {
    t.skip('PostgreSQL is not running locally; skipping schema check.');
    return;
  }
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'
     ORDER BY table_name`
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    [...TENANT_TABLES].sort(),
    'add new tenant tables to TENANT_TABLES in tests/helpers.js'
  );
});
