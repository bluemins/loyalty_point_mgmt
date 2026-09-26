const crypto = require("crypto");
const { env } = require("../config/env");
const { hashPassword, verifyPassword } = require("./passwords");
const { findTenantBySlug } = require("./tenants");
const { AppError } = require("./errors");

// Admin identity is global (a super_admin belongs to no tenant), so the
// admin_users lookups below are the one place that queries without tenant_id.
// Admin Redis keys live under "adm:" for the same reason.
const COOKIE_NAME = "asid";
const COOKIE_PATH = "/admin";
const SESSION_TTL_SECONDS = env.ADMIN_SESSION_TTL_HOURS * 60 * 60;
const LOGIN_WINDOW_SECONDS = env.ADMIN_LOGIN_WINDOW_MINUTES * 60;
const ROLES = ["super_admin", "tenant_admin"];

// Compared against when the email is unknown, so both failures take as long.
let dummyHash;
async function getDummyHash() {
  dummyHash = dummyHash || (await hashPassword(crypto.randomBytes(16).toString("hex")));
  return dummyHash;
}

function normaliseEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

async function createAdmin(db, { email, password, role, tenantId = null }) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  if (typeof password !== "string" || password.length < 10) throw new Error("password must be at least 10 characters");
  const { rows } = await db.query(
    `INSERT INTO admin_users (email, password_hash, role, tenant_id)
     VALUES ($1, $2, $3, $4) RETURNING id, email, role, tenant_id`,
    [normaliseEmail(email), await hashPassword(password), role, role === "super_admin" ? null : tenantId]
  );
  return rows[0];
}

function loginKeys(email, ip) {
  return { emailKey: `adm:rl:email:${email}`, ipKey: `adm:rl:ip:${ip}` };
}

// Only failed attempts count. Locked out: 429, checked before the password
// so a locked account cannot be probed.
async function login({ db, redis }, { email, password, ip }) {
  const normalised = normaliseEmail(email);
  const { emailKey, ipKey } = loginKeys(normalised, ip);
  const [emailFails, ipFails] = await Promise.all([redis.get(emailKey), redis.get(ipKey)]);
  const emailLocked = Number(emailFails) >= env.ADMIN_LOGIN_MAX_FAILURES;
  const ipLocked = Number(ipFails) >= env.ADMIN_LOGIN_MAX_FAILURES_PER_IP;
  if (emailLocked || ipLocked) {
    // Report the wait for the limit that was actually hit.
    const ttl = Math.max(emailLocked ? await redis.ttl(emailKey) : 0, ipLocked ? await redis.ttl(ipKey) : 0, 1);
    throw new AppError(429, "too_many_attempts", { retry_after_seconds: ttl });
  }

  const { rows } = await db.query("SELECT id, email, role, tenant_id, password_hash FROM admin_users WHERE email = $1", [
    normalised
  ]);
  const admin = rows[0];
  const ok = await verifyPassword(String(password ?? ""), admin ? admin.password_hash : await getDummyHash());

  if (!admin || !ok) {
    await redis
      .multi()
      .incr(emailKey)
      .expire(emailKey, LOGIN_WINDOW_SECONDS, "NX")
      .incr(ipKey)
      .expire(ipKey, 60 * 60, "NX")
      .exec();
    throw new AppError(401, "invalid_credentials");
  }

  await redis.del(emailKey);
  await db.query("UPDATE admin_users SET last_login_at = NOW() WHERE id = $1", [admin.id]);
  return { id: admin.id, email: admin.email, role: admin.role, tenant_id: admin.tenant_id };
}

// The cookie carries "<admin_id>:<random>", signed. The admin id in the key
// lets every session of one admin be found (and revoked) together.
function sessionKey(cookieValue) {
  return `adm:sess:${cookieValue}`;
}

async function startSession(redis, res, admin) {
  const value = `${admin.id}:${crypto.randomBytes(32).toString("base64url")}`;
  await redis.set(sessionKey(value), JSON.stringify({ admin_id: admin.id }), { EX: SESSION_TTL_SECONDS });
  res.cookie(COOKIE_NAME, value, {
    signed: true,
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: COOKIE_PATH,
    maxAge: SESSION_TTL_SECONDS * 1000
  });
}

async function endSession(req, res) {
  if (req.adminSessionKey) await req.app.locals.redis.del(req.adminSessionKey);
  res.clearCookie(COOKIE_NAME, { signed: true, httpOnly: true, sameSite: "strict", path: COOKIE_PATH });
}

// Middleware: sets req.admin from a valid session. The admin row is re-read on
// every request, so a deleted admin or a changed role takes effect at once.
async function loadAdmin(req, res, next) {
  try {
    const value = req.signedCookies?.[COOKIE_NAME];
    if (value) {
      const key = sessionKey(value);
      const raw = await req.app.locals.redis.get(key);
      if (raw) {
        const { admin_id: adminId } = JSON.parse(raw);
        const { rows } = await req.app.locals.db.query(
          "SELECT id, email, role, tenant_id FROM admin_users WHERE id = $1",
          [adminId]
        );
        if (rows[0]) {
          req.admin = rows[0];
          req.adminSessionKey = key;
        }
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: "not_authenticated" });
  next();
}

// A tenant_admin asking for any other tenant gets the same 404 as a tenant
// that does not exist, so they cannot even learn which tenants exist.
async function resolveAdminTenant(req, res, next) {
  try {
    const tenant = await findTenantBySlug(req.app.locals.db, req.params.slug);
    const allowed = tenant && (req.admin.role === "super_admin" || req.admin.tenant_id === tenant.id);
    if (!allowed) return res.status(404).json({ error: "tenant_not_found" });
    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
}

async function tenantsFor(db, admin) {
  const { rows } =
    admin.role === "super_admin"
      ? await db.query("SELECT id, slug, name FROM tenants WHERE active = true ORDER BY name")
      : await db.query("SELECT id, slug, name FROM tenants WHERE id = $1 AND active = true", [admin.tenant_id]);
  return rows.map((t) => ({ slug: t.slug, name: t.name }));
}

module.exports = {
  COOKIE_NAME,
  normaliseEmail,
  createAdmin,
  login,
  startSession,
  endSession,
  loadAdmin,
  requireAdmin,
  resolveAdminTenant,
  tenantsFor
};
