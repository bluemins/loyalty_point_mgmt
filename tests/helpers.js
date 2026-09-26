const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MOCK_OTP } = require('../src/services/msg91');

// Every table that carries tenant_id. Teardown checks all of them.
const TENANT_TABLES = [
  'settings',
  'users',
  'otp_requests',
  'device_tokens',
  'scan_events',
  'ledger',
  'rewards',
  'redemptions',
  'admin_users',
  'admin_action_log'
];

async function createTestTenant(pool, label, settings = {}) {
  const slug = `test-${label}-${crypto.randomBytes(4).toString('hex')}`;
  const { rows } = await pool.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug',
    [slug, `Test ${label}`]
  );
  await setSettings(pool, rows[0], settings);
  return rows[0];
}

async function setSettings(pool, tenant, settings) {
  for (const [key, value] of Object.entries(settings)) {
    await pool.query(
      `INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [tenant.id, key, JSON.stringify(value)]
    );
  }
}

// All Redis keys for a tenant contain ":<tenant_id>:", so one pattern finds them.
async function redisKeysFor(redis, tenant) {
  const keys = [];
  for await (const key of redis.scanIterator({ MATCH: `*:${tenant.id}:*` })) keys.push(key);
  return keys;
}

async function clearRedisFor(redis, tenant) {
  for (const key of await redisKeysFor(redis, tenant)) await redis.del(key);
}

// Deletes the tenant and everything it owns, then proves nothing was left in
// Postgres or Redis. A new table or key format that escapes cleanup fails here.
async function destroyTestTenant(pool, redis, tenant) {
  await clearRedisFor(redis, tenant);
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);

  for (const table of TENANT_TABLES) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [
      tenant.id
    ]);
    assert.equal(rows[0].n, 0, `${table} still has rows for test tenant ${tenant.slug}`);
  }
  assert.deepEqual(await redisKeysFor(redis, tenant), [], `Redis keys left for ${tenant.slug}`);
}

// A minimal browser: keeps cookies between requests to one tenant.
function createBrowser(baseUrl, tenant) {
  const jar = {};
  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}/t/${tenant.slug}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = pair.split('=');
      jar[name] = value;
    }
    return { status: res.status, body: await res.json() };
  }
  return {
    jar,
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    scan: () => request('POST', '/scan', {}),
    async login(phone) {
      await request('POST', '/otp/send', { phone });
      return request('POST', '/otp/verify', { phone, otp: MOCK_OTP });
    }
  };
}

function randomPhone() {
  return `9${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
}

module.exports = {
  createBrowser,
  randomPhone,
  TENANT_TABLES,
  createTestTenant,
  setSettings,
  redisKeysFor,
  clearRedisFor,
  destroyTestTenant
};
