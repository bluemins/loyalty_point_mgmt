const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const { env } = require('../src/config/env');
const { pool, redis } = require('../src/db');
const { normalizePhone } = require('../src/services/phone');
const { otpKey, MAX_VERIFY_ATTEMPTS } = require('../src/services/otp');
const { MOCK_OTP } = require('../src/services/msg91');

let server;
let baseUrl;
let tenantA; // no MSG91 overrides in settings
let tenantB; // overrides msg91_sender_id and msg91_template_id

async function createTenant(label, settings = {}) {
  const slug = `test-${label}-${crypto.randomBytes(4).toString('hex')}`;
  const { rows } = await pool.query(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug',
    [slug, `Test ${label}`]
  );
  for (const [key, value] of Object.entries(settings)) {
    await pool.query(
      'INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)',
      [rows[0].id, key, JSON.stringify(value)]
    );
  }
  return rows[0];
}

async function clearRedisFor(tenant) {
  for await (const key of redis.scanIterator({ MATCH: `*:${tenant.id}:*` })) {
    await redis.del(key);
  }
}

function post(tenant, path, body, headers = {}) {
  return fetch(`${baseUrl}/t/${tenant.slug}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

// Records MSG91 calls and answers with a canned success response.
function stubMsg91() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ type: 'success' }), { status: 200 });
  };
  return { calls, fetchImpl };
}

before(async () => {
  await redis.connect();
  app.locals.db = pool;
  app.locals.redis = redis;

  tenantA = await createTenant('a');
  tenantB = await createTenant('b', {
    msg91_sender_id: 'TENANTB',
    msg91_template_id: 'TPL_B'
  });

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  app.locals.msg91 = undefined;
  await clearRedisFor(tenantA);
  await clearRedisFor(tenantB);
});

after(async () => {
  await clearRedisFor(tenantA);
  await clearRedisFor(tenantB);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantA.id, tenantB.id]]);
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

test('phone numbers normalise to E.164 with +91 default', () => {
  assert.equal(normalizePhone('9876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '+919876543210');
  assert.equal(normalizePhone('09876543210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
  assert.equal(normalizePhone('0091 9876543210'), '+919876543210');
  assert.equal(normalizePhone('+14155552671'), '+14155552671');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('5876543210'), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone(undefined), null);
});

test('unknown tenant slug returns 404', async () => {
  const res = await post({ slug: 'no-such-tenant' }, '/otp/send', { phone: '9876543210' });
  assert.equal(res.status, 404);
});

test('invalid phone is rejected', async () => {
  const res = await post(tenantA, '/otp/send', { phone: '123' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_phone');
});

test('mock mode: no HTTP call, fixed OTP verifies and sets a signed httpOnly cookie', async () => {
  const stub = stubMsg91();
  app.locals.msg91 = { authKey: '', fetchImpl: stub.fetchImpl };

  const send = await post(tenantA, '/otp/send', { phone: '9876543210' });
  assert.equal(send.status, 200);
  const sendBody = await send.json();
  assert.equal(sendBody.mock, true);
  assert.equal(sendBody.phone, '+919876543210');

  const verify = await post(tenantA, '/otp/verify', { phone: '9876543210', otp: MOCK_OTP });
  assert.equal(verify.status, 200);
  assert.equal(stub.calls.length, 0);

  const cookie = verify.headers.getSetCookie()[0];
  assert.match(cookie, /^sid=s%3A/); // "s:" prefix means cookie-parser signed it
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, new RegExp(`Path=/t/${tenantA.slug}`));

  const audit = await pool.query(
    'SELECT status FROM otp_requests WHERE tenant_id = $1 AND phone_e164 = $2',
    [tenantA.id, '+919876543210']
  );
  assert.equal(audit.rows[0].status, 'verified');
});

test('session is Redis-backed: valid, tamper-proof, tenant-scoped and revocable', async () => {
  await post(tenantA, '/otp/send', { phone: '9876500001' });
  const verify = await post(tenantA, '/otp/verify', { phone: '9876500001', otp: MOCK_OTP });
  const cookie = verify.headers.getSetCookie()[0].split(';')[0];

  const getSession = (tenant, c) =>
    fetch(`${baseUrl}/t/${tenant.slug}/session`, { headers: { Cookie: c } }).then((r) => r.json());

  assert.deepEqual(await getSession(tenantA, cookie), {
    authenticated: true,
    phone: '+919876500001'
  });

  const tampered = cookie.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
  assert.deepEqual(await getSession(tenantA, tampered), { authenticated: false });

  // The same cookie presented to another tenant is not a session there.
  assert.deepEqual(await getSession(tenantB, cookie), { authenticated: false });

  // Logout deletes the Redis session, so even a copied cookie stops working.
  await post(tenantA, '/logout', {}, { Cookie: cookie });
  assert.deepEqual(await getSession(tenantA, cookie), { authenticated: false });
});

test('send is rate limited per phone (3 per 15 minutes)', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await post(tenantA, '/otp/send', { phone: '9876500002' });
    assert.equal(res.status, 200);
  }
  const res = await post(tenantA, '/otp/send', { phone: '9876500002' });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'rate_limited');
  assert.ok(body.retry_after_seconds > 0 && body.retry_after_seconds <= 15 * 60);

  // A different phone from the same IP is still allowed.
  const other = await post(tenantA, '/otp/send', { phone: '9876500003' });
  assert.equal(other.status, 200);
});

test('send is rate limited per IP (10 per hour)', async () => {
  for (let i = 0; i < 10; i++) {
    const res = await post(tenantA, '/otp/send', { phone: `98765100${String(i).padStart(2, '0')}` });
    assert.equal(res.status, 200, `send ${i + 1} should succeed`);
  }
  const res = await post(tenantA, '/otp/send', { phone: '9876510099' });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.ok(body.retry_after_seconds > 15 * 60, 'IP window is one hour');
});

test('verify allows 5 attempts per OTP, then locks it', async () => {
  await post(tenantA, '/otp/send', { phone: '9876500004' });

  for (let i = 1; i <= MAX_VERIFY_ATTEMPTS; i++) {
    const res = await post(tenantA, '/otp/verify', { phone: '9876500004', otp: '111111' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).attempts_left, MAX_VERIFY_ATTEMPTS - i);
  }

  // Even the correct OTP is refused once attempts are used up.
  const locked = await post(tenantA, '/otp/verify', { phone: '9876500004', otp: MOCK_OTP });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'too_many_attempts');

  // Requesting a new OTP resets the attempt count.
  await post(tenantA, '/otp/send', { phone: '9876500004' });
  const ok = await post(tenantA, '/otp/verify', { phone: '9876500004', otp: MOCK_OTP });
  assert.equal(ok.status, 200);
});

test('OTP expires after 5 minutes', async () => {
  await post(tenantA, '/otp/send', { phone: '9876500005' });

  const key = otpKey(tenantA.id, '+919876500005');
  const ttl = await redis.ttl(key);
  assert.ok(ttl > 290 && ttl <= 300, `expected ~300s TTL, got ${ttl}`);

  // Fast-forward: let the key expire instead of waiting 5 real minutes.
  await redis.pExpire(key, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const res = await post(tenantA, '/otp/verify', { phone: '9876500005', otp: MOCK_OTP });
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, 'otp_expired');
  assert.equal(await redis.exists(key), 0, 'no stray key left behind');
});

test('verify without a prior send is treated as expired', async () => {
  const res = await post(tenantA, '/otp/verify', { phone: '9876500006', otp: MOCK_OTP });
  assert.equal(res.status, 410);
});

test('real mode uses tenant sender/template overrides from settings', async () => {
  const stub = stubMsg91();
  app.locals.msg91 = { authKey: 'test-auth-key', fetchImpl: stub.fetchImpl };

  const send = await post(tenantB, '/otp/send', { phone: '9876500007' });
  assert.equal(send.status, 200);
  assert.equal((await send.json()).mock, undefined);

  const [sendCall] = stub.calls;
  assert.equal(sendCall.init.method, 'POST');
  assert.equal(sendCall.url.origin + sendCall.url.pathname, 'https://control.msg91.com/api/v5/otp');
  assert.equal(sendCall.init.headers.authkey, 'test-auth-key');
  assert.equal(sendCall.url.searchParams.get('template_id'), 'TPL_B');
  assert.equal(sendCall.url.searchParams.get('sender'), 'TENANTB');
  assert.equal(sendCall.url.searchParams.get('mobile'), '919876500007');
  assert.equal(sendCall.url.searchParams.get('otp_expiry'), '5');

  const verify = await post(tenantB, '/otp/verify', { phone: '9876500007', otp: '482913' });
  assert.equal(verify.status, 200);

  const verifyCall = stub.calls[1];
  assert.equal(verifyCall.init.method, 'GET');
  assert.equal(verifyCall.url.pathname, '/api/v5/otp/verify');
  assert.equal(verifyCall.url.searchParams.get('otp'), '482913');
  assert.equal(verifyCall.url.searchParams.get('mobile'), '919876500007');
});

test('real mode falls back to env sender/template when tenant has no override', async () => {
  const stub = stubMsg91();
  app.locals.msg91 = { authKey: 'test-auth-key', fetchImpl: stub.fetchImpl };

  await post(tenantA, '/otp/send', { phone: '9876500008' });
  const { searchParams } = stub.calls[0].url;
  assert.equal(searchParams.get('template_id'), env.MSG91_TEMPLATE_ID);
  assert.equal(searchParams.get('sender'), env.MSG91_SENDER_ID);
});

test('real mode: a wrong OTP reported by MSG91 is rejected', async () => {
  app.locals.msg91 = {
    authKey: 'test-auth-key',
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify(url.includes('/verify') ? { type: 'error', message: 'OTP not match' } : { type: 'success' }),
        { status: 200 }
      )
  };

  await post(tenantB, '/otp/send', { phone: '9876500009' });
  const res = await post(tenantB, '/otp/verify', { phone: '9876500009', otp: '000000' });
  assert.equal(res.status, 401);
});
