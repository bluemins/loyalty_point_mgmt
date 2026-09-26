const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { env } = require('../src/config/env');
const { pool, redis, pingServices } = require('../src/db');

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

test('seed data creates the demo tenant and reward catalog', async (t) => {
  const dbAvailable = await ensureDatabaseAvailable();
  const redisAvailable = await ensureRedisAvailable();

  if (!dbAvailable) {
    t.skip('PostgreSQL is not running locally; skipping seed validation test.');
    return;
  }

  const tenantResult = await pool.query(
    `SELECT COUNT(*) AS tenant_count FROM tenants WHERE slug = $1`,
    [env.DEMO_TENANT_SLUG]
  );

  const settingResult = await pool.query(
    `SELECT COUNT(*) AS setting_count FROM settings WHERE tenant_id = (
      SELECT id FROM tenants WHERE slug = $1
    )`,
    [env.DEMO_TENANT_SLUG]
  );

  const rewardResult = await pool.query(
    `SELECT COUNT(*) AS reward_count FROM rewards WHERE tenant_id = (
      SELECT id FROM tenants WHERE slug = $1
    )`,
    [env.DEMO_TENANT_SLUG]
  );

  assert.equal(Number(tenantResult.rows[0].tenant_count), 1);
  assert.ok(Number(settingResult.rows[0].setting_count) >= 1);
  assert.ok(Number(rewardResult.rows[0].reward_count) >= 3);

  if (redisAvailable && redis.isOpen) {
    await redis.quit();
  }
});
