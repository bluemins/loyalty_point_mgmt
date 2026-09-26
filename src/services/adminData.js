const { z } = require("zod");
const { tenantQuery } = require("../db/tenantDb");
const { inTransaction } = require("../db/transaction");
const { getSettings, SETTING_DEFAULTS } = require("./tenants");
const { getBalance } = require("./ledger");
const { safeLogoUrl, safeColors } = require("./theme");
const { writeAdminLog } = require("./adminLog");
const { AppError } = require("./errors");

const PAGE_SIZE = 50;
const LEDGER_TYPES = ["scan", "redeem", "expire", "adjust", "refund"];
const REDEMPTION_STATUSES = ["issued", "fulfilled", "cancelled", "expired"];

function pageOf(page) {
  const n = Number.parseInt(page, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// Fetch one extra row to know whether another page exists.
function paged(rows, page) {
  return { items: rows.slice(0, PAGE_SIZE), page, has_more: rows.length > PAGE_SIZE };
}

function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Balance per user, computed the same way as ledger.getBalance.
const USER_BALANCE = `
  COALESCE((
    SELECT SUM(remaining) FROM (
      SELECT c.amount + COALESCE((
        SELECT SUM(d.amount) FROM ledger d
        WHERE d.tenant_id = c.tenant_id AND d.consumes_ledger_id = c.id
      ), 0) AS remaining
      FROM ledger c
      WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id AND c.amount > 0 AND c.expires_at > NOW()
    ) credits
  ), 0)::int`;

// A voucher past its date reads as expired even before the nightly job marks it.
const EFFECTIVE_STATUS = `CASE WHEN r.status = 'issued' AND r.voucher_expires_at <= NOW() THEN 'expired' ELSE r.status END`;

// ---------- users ----------

async function listUsers(db, tenantId, { q, page }) {
  const p = pageOf(page);
  const search = typeof q === "string" && q.trim() ? likePattern(q.trim()) : null;
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT u.id, u.phone_e164, u.name, u.category, u.created_at, ${USER_BALANCE} AS balance
     FROM users u
     WHERE u.tenant_id = $1
       AND ($2::text IS NULL OR u.phone_e164 ILIKE $2 OR u.name ILIKE $2)
     ORDER BY u.created_at DESC
     LIMIT $3 OFFSET $4`,
    [search, PAGE_SIZE + 1, (p - 1) * PAGE_SIZE]
  );
  return paged(result.rows, p);
}

async function getUser(db, tenantId, userId) {
  const user = await tenantQuery(
    db,
    tenantId,
    "SELECT id, phone_e164, name, category, status, created_at FROM users WHERE tenant_id = $1 AND id = $2",
    [userId]
  );
  if (!user.rows[0]) throw new AppError(404, "user_not_found");

  const [balance, ledger, redemptions] = await Promise.all([
    getBalance(db, tenantId, userId, new Date()),
    tenantQuery(
      db,
      tenantId,
      `SELECT id, type, amount, reference_type, reference_id, expires_at, created_at
       FROM ledger WHERE tenant_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 100`,
      [userId]
    ),
    tenantQuery(
      db,
      tenantId,
      `SELECT r.id, ${EFFECTIVE_STATUS} AS status, r.voucher_code, r.points_spent,
              r.voucher_expires_at, r.created_at, rw.name AS reward_name
       FROM redemptions r JOIN rewards rw ON rw.tenant_id = r.tenant_id AND rw.id = r.reward_id
       WHERE r.tenant_id = $1 AND r.user_id = $2
       ORDER BY r.created_at DESC LIMIT 100`,
      [userId]
    )
  ]);
  return { user: user.rows[0], balance, ledger: ledger.rows, redemptions: redemptions.rows };
}

// ---------- ledger ----------

async function listLedger(db, tenantId, { userId, type, page }) {
  const p = pageOf(page);
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT l.id, l.type, l.amount, l.reference_type, l.reference_id, l.expires_at, l.created_at,
            u.id AS user_id, u.phone_e164, u.name
     FROM ledger l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
     WHERE l.tenant_id = $1
       AND ($2::uuid IS NULL OR l.user_id = $2)
       AND ($3::text IS NULL OR l.type = $3)
     ORDER BY l.created_at DESC, l.id
     LIMIT $4 OFFSET $5`,
    [userId || null, LEDGER_TYPES.includes(type) ? type : null, PAGE_SIZE + 1, (p - 1) * PAGE_SIZE]
  );
  return paged(result.rows, p);
}

// ---------- redemptions ----------

async function listRedemptions(db, tenantId, { status, page }) {
  const p = pageOf(page);
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT * FROM (
       SELECT r.id, ${EFFECTIVE_STATUS} AS status, r.voucher_code, r.points_spent,
              r.voucher_expires_at, r.created_at, r.fulfilled_at, r.cancelled_at,
              rw.name AS reward_name, u.id AS user_id, u.phone_e164, u.name
       FROM redemptions r
       JOIN rewards rw ON rw.tenant_id = r.tenant_id AND rw.id = r.reward_id
       JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
       WHERE r.tenant_id = $1
     ) rows
     WHERE ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [REDEMPTION_STATUSES.includes(status) ? status : null, PAGE_SIZE + 1, (p - 1) * PAGE_SIZE]
  );
  return paged(result.rows, p);
}

// ---------- settings ----------

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour like #4A2412");
const int = (min, max) => z.number().int().min(min).max(max);

// Every setting an admin may change, with its rule. Anything else is rejected.
const SETTINGS_SCHEMA = {
  brand_name: z.string().trim().min(1).max(60),
  tagline: z.string().trim().max(120),
  colors: z.object({ b1: hex, b2: hex, soft: hex }).strict(),
  hero_texture: z.enum(["none", "wood"]),
  logo_url: z.string().max(500).refine((v) => safeLogoUrl(v) !== null, "must be an http(s) URL or a /path").nullable(),
  user_categories: z
    .array(z.string().trim().min(1).max(40))
    .min(1)
    .max(10)
    .refine((list) => new Set(list).size === list.length, "categories must be unique"),
  points_per_scan: int(1, 1000),
  scan_cooldown_minutes: int(0, 1440),
  daily_scan_cap: int(1, 100),
  points_expiry_days: int(1, 3650),
  pending_points_ttl_days: int(1, 365),
  expiring_soon_days: int(1, 90),
  voucher_validity_days: int(1, 3650),
  otp_send_limit_per_phone: int(1, 20),
  otp_send_window_phone_minutes: int(1, 1440),
  otp_send_limit_per_ip: int(1, 1000),
  otp_send_window_ip_minutes: int(1, 1440),
  msg91_sender_id: z.string().regex(/^[A-Z]{6}$/, "must be 6 capital letters").nullable(),
  msg91_template_id: z.string().trim().min(1).max(64).nullable()
};

// OTP limits and MSG91 IDs control SMS spend on the platform's MSG91 account,
// so only a super_admin may change them.
function superAdminOnly(key) {
  return key.startsWith("otp_") || key.startsWith("msg91_");
}

function editableKeys(role) {
  return Object.keys(SETTINGS_SCHEMA).filter((key) => role === "super_admin" || !superAdminOnly(key));
}

// Effective values: what the app actually uses when a key was never set, so
// the editor never shows (or saves back) a blank or placeholder value.
function effectiveDefaults(tenant) {
  return { brand_name: tenant.name, tagline: "", colors: safeColors(undefined), user_categories: [] };
}

async function getAdminSettings(db, tenant, role) {
  const all = await getSettings(db, tenant.id);
  const fallback = { ...SETTING_DEFAULTS, ...effectiveDefaults(tenant) };
  const settings = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    const value = key in all ? all[key] : fallback[key];
    settings[key] = value === undefined ? null : value;
  }
  settings.colors = safeColors(settings.colors);
  return { settings, editable: editableKeys(role) };
}

async function updateSettings(db, tenant, admin, patch) {
  const tenantId = tenant.id;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new AppError(400, "invalid_settings");
  }
  const values = {};
  for (const [key, value] of Object.entries(patch)) {
    const schema = SETTINGS_SCHEMA[key];
    if (!schema) throw new AppError(400, "unknown_setting", { key });
    if (!editableKeys(admin.role).includes(key)) throw new AppError(403, "forbidden_setting", { key });
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError(400, "invalid_setting", { key, message: parsed.error.issues[0].message });
    }
    values[key] = parsed.data;
  }

  return inTransaction(db, async (client) => {
    const before = (await getAdminSettings(client, tenant, admin.role)).settings;
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
      await tenantQuery(
        client,
        tenantId,
        `INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
      changes[key] = { from: before[key], to: value };
    }
    if (Object.keys(changes).length > 0) {
      await writeAdminLog(client, tenantId, {
        adminId: admin.id,
        action: "settings.update",
        entityType: "settings",
        details: changes
      });
    }
    return { changed: Object.keys(changes), ...(await getAdminSettings(client, tenant, admin.role)) };
  });
}

// ---------- rewards ----------

const REWARD_FIELDS = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable(),
  image_url: z.string().max(500).refine((v) => safeLogoUrl(v) !== null, "must be an http(s) URL or a /path").nullable(),
  points_cost: int(1, 1000000),
  stock: int(0, 1000000),
  active: z.boolean()
};
const newRewardSchema = z
  .object({ ...REWARD_FIELDS, description: REWARD_FIELDS.description.optional(), image_url: REWARD_FIELDS.image_url.optional(), active: REWARD_FIELDS.active.optional() })
  .strict();
const rewardPatchSchema = z
  .object(REWARD_FIELDS)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to update");

function parseOrThrow(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(400, "invalid_reward", { field: issue.path[0] ?? null, message: issue.message });
  }
  return parsed.data;
}

const REWARD_COLUMNS = "id, type, name, description, image_url, points_cost, stock, active, created_at, updated_at";

async function listAdminRewards(db, tenantId) {
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT ${REWARD_COLUMNS} FROM rewards WHERE tenant_id = $1 ORDER BY active DESC, points_cost, name`
  );
  return result.rows;
}

// Only vouchers for now; the catalog is ready for 'product' later.
async function createReward(db, tenantId, admin, body) {
  const data = parseOrThrow(newRewardSchema, body);
  return inTransaction(db, async (client) => {
    const result = await tenantQuery(
      client,
      tenantId,
      `INSERT INTO rewards (tenant_id, type, name, description, image_url, points_cost, stock, active, is_catalog_ready)
       VALUES ($1, 'voucher', $2, $3, $4, $5, $6, $7, true)
       RETURNING ${REWARD_COLUMNS}`,
      [data.name, data.description ?? null, data.image_url ?? null, data.points_cost, data.stock, data.active ?? true]
    );
    const reward = result.rows[0];
    await writeAdminLog(client, tenantId, {
      adminId: admin.id,
      action: "reward.create",
      entityType: "reward",
      entityId: reward.id,
      details: data
    });
    return reward;
  });
}

async function updateReward(db, tenantId, admin, rewardId, body) {
  const data = parseOrThrow(rewardPatchSchema, body);
  return inTransaction(db, async (client) => {
    const current = await tenantQuery(
      client,
      tenantId,
      `SELECT ${REWARD_COLUMNS} FROM rewards WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [rewardId]
    );
    if (!current.rows[0]) throw new AppError(404, "reward_not_found");

    const keys = Object.keys(data);
    const sets = keys.map((key, i) => `${key} = $${i + 3}`).join(", ");
    const result = await tenantQuery(
      client,
      tenantId,
      `UPDATE rewards SET ${sets}, updated_at = NOW() WHERE tenant_id = $1 AND id = $2 RETURNING ${REWARD_COLUMNS}`,
      [rewardId, ...keys.map((key) => data[key])]
    );
    const changes = {};
    for (const key of keys) changes[key] = { from: current.rows[0][key], to: data[key] };
    await writeAdminLog(client, tenantId, {
      adminId: admin.id,
      action: "reward.update",
      entityType: "reward",
      entityId: rewardId,
      details: changes
    });
    return result.rows[0];
  });
}

module.exports = {
  PAGE_SIZE,
  SETTINGS_SCHEMA,
  listUsers,
  getUser,
  listLedger,
  listRedemptions,
  getAdminSettings,
  updateSettings,
  listAdminRewards,
  createReward,
  updateReward
};
