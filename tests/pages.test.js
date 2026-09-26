const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { pool, redis } = require('../src/db');
const { createTestTenant, setSettings, destroyTestTenant, createBrowser, randomPhone } = require('./helpers');

const CATEGORIES = ['Carpenter', 'Contractor', 'End User'];
const WOOD = { b1: '#4A2412', b2: '#C8742B', soft: '#FBF3E6' };
const TEAL = { b1: '#0F3D3E', b2: '#1F8A70', soft: '#EEF7F4' };

let server;
let baseUrl;
let wood;
let teal;

async function page(tenant, path = '/scan', accept = 'text/html') {
  const res = await fetch(`${baseUrl}/t/${tenant.slug}${path}`, { headers: { Accept: accept } });
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
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
  wood = await createTestTenant(pool, 'theme-wood', {
    user_categories: CATEGORIES,
    brand_name: 'Walnut Ply',
    tagline: 'Built on trust',
    colors: WOOD,
    hero_texture: 'wood'
  });
  teal = await createTestTenant(pool, 'theme-teal', {
    user_categories: CATEGORIES,
    brand_name: 'Teal Laminates',
    tagline: 'Surfaces that last',
    colors: TEAL,
    hero_texture: 'none'
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await destroyTestTenant(pool, redis, wood);
  await destroyTestTenant(pool, redis, teal);
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await pool.end();
});

test('each tenant page carries its own theme colours, texture and brand', async () => {
  const w = await page(wood);
  const t = await page(teal);

  assert.equal(w.status, 200);
  assert.match(w.type, /text\/html/);
  assert.ok(w.text.includes(':root { --b1: #4A2412; --b2: #C8742B; --soft: #FBF3E6; }'));
  assert.ok(w.text.includes('class="texture-wood"'));
  assert.ok(w.text.includes('<span class="brand-name">Walnut Ply</span>'));
  assert.ok(w.text.includes(`data-slug="${wood.slug}" data-mode="scan"`));

  assert.ok(t.text.includes(':root { --b1: #0F3D3E; --b2: #1F8A70; --soft: #EEF7F4; }'));
  assert.ok(t.text.includes('class="texture-none"'));
  assert.ok(t.text.includes('<span class="brand-name">Teal Laminates</span>'));
  assert.ok(!t.text.includes('#4A2412'), 'no colours leak from the other tenant');
});

test('no brand colour is hard-coded in the stylesheet', async () => {
  const res = await fetch(`${baseUrl}/static/app.css`);
  const css = await res.text();
  assert.equal(res.status, 200);
  for (const color of [...Object.values(WOOD), ...Object.values(TEAL)]) {
    assert.ok(!css.toLowerCase().includes(color.toLowerCase()), `${color} hard-coded in app.css`);
  }
});

test('opening the QR page does not record a scan; only the POST does', async () => {
  const count = async () =>
    (await pool.query('SELECT COUNT(*)::int AS n FROM scan_events WHERE tenant_id = $1', [teal.id])).rows[0].n;
  const before = await count();
  await page(teal, '/scan');
  await page(teal, '/');
  assert.equal(await count(), before);
});

test('/ serves the app in home mode', async () => {
  const res = await page(teal, '/');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('data-mode="home"'));
});

test('brand text is HTML-escaped and unsafe theme values fall back', async () => {
  const t = await createTestTenant(pool, 'theme-evil', {
    brand_name: '<script>alert(1)</script>"Evil"',
    tagline: '<img src=x onerror=alert(2)>',
    colors: { b1: 'red; } body { display:none', b2: '#12345', soft: 'url(javascript:alert(3))' },
    hero_texture: 'wood"><script>',
    logo_url: 'javascript:alert(4)'
  });
  try {
    const { text } = await page(t);
    assert.ok(!text.includes('<script>alert'), 'script tag escaped');
    assert.ok(!text.includes('<img src=x'), 'img tag escaped');
    assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;Evil&quot;'));
    assert.ok(text.includes(':root { --b1: #1F2937; --b2: #4B5563; --soft: #F9FAFB; }'), 'default colours used');
    assert.ok(text.includes('class="texture-none"'));
    assert.ok(!text.includes('javascript:'), 'unsafe logo URL dropped');
    assert.ok(text.includes('<span class="logo initials">'));
  } finally {
    await destroyTestTenant(pool, redis, t);
  }
});

test('a valid logo_url is shown as an image', async () => {
  await setSettings(pool, teal, { logo_url: 'https://cdn.example.com/logo.png' });
  try {
    const { text } = await page(teal);
    assert.ok(text.includes('<img class="logo" src="https://cdn.example.com/logo.png" alt="">'));
  } finally {
    await pool.query("DELETE FROM settings WHERE tenant_id = $1 AND key = 'logo_url'", [teal.id]);
  }
});

test('/config returns the public tenant config and nothing secret', async () => {
  const res = await fetch(`${baseUrl}/t/${wood.slug}/config`);
  const config = await res.json();
  assert.deepEqual(config, {
    slug: wood.slug,
    brand_name: 'Walnut Ply',
    brand_initials: 'WP',
    tagline: 'Built on trust',
    logo_url: null,
    colors: WOOD,
    hero_texture: 'wood',
    user_categories: CATEGORIES,
    points_per_scan: 10
  });
});

test('an unknown tenant gets an HTML page in a browser and JSON from the API', async () => {
  const html = await page({ slug: 'no-such-tenant' }, '/scan');
  assert.equal(html.status, 404);
  assert.match(html.type, /text\/html/);
  assert.match(html.text, /scan the QR code again/);

  const json = await page({ slug: 'no-such-tenant' }, '/config', 'application/json');
  assert.equal(json.status, 404);
  assert.deepEqual(JSON.parse(json.text), { error: 'tenant_not_found' });
});

test('/session tells the app whether the profile exists', async () => {
  const b = createBrowser(baseUrl, wood);
  assert.deepEqual((await b.get('/session')).body, { authenticated: false });

  const phone = randomPhone();
  await b.login(phone);
  assert.deepEqual((await b.get('/session')).body, {
    authenticated: true,
    phone: `+91${phone}`,
    has_profile: false
  });

  await b.post('/profile', { name: 'Asha', category: 'Carpenter' });
  assert.equal((await b.get('/session')).body.has_profile, true);
});

test('static assets are served', async () => {
  for (const file of ['app.js', 'app.css']) {
    const res = await fetch(`${baseUrl}/static/${file}`);
    assert.equal(res.status, 200, file);
  }
});
