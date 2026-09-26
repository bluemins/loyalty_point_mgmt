const crypto = require("crypto");
const { env } = require("../config/env");

// User sessions live in Redis so logout and bans take effect immediately.
// The cookie only carries a random session id, signed with SESSION_SECRET.
const COOKIE_NAME = "sid";
const TTL_SECONDS = env.SESSION_TTL_DAYS * 24 * 60 * 60;

// The tenant id in the key keeps every Redis key for a tenant findable
// (and deletable) by the same *:<tenant_id>:* pattern.
function sessionKey(tenantId, id) {
  return `sess:${tenantId}:${id}`;
}

// Scoping the cookie to /t/<slug> gives each tenant its own session cookie.
function cookieOptions(tenant) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: `/t/${tenant.slug}`
  };
}

// userId is null for a verified phone that has not created its profile yet.
async function createUserSession(redis, res, tenant, phoneE164, userId = null) {
  const id = crypto.randomBytes(32).toString("base64url");
  const data = {
    role: "user",
    tenant_id: tenant.id,
    phone_e164: phoneE164,
    user_id: userId,
    created_at: new Date().toISOString()
  };
  await redis.set(sessionKey(tenant.id, id), JSON.stringify(data), { EX: TTL_SECONDS });
  res.cookie(COOKIE_NAME, id, { ...cookieOptions(tenant), maxAge: TTL_SECONDS * 1000 });
  return data;
}

// Attaches the new user to the current session once the profile is created.
async function setSessionUser(req, userId) {
  const data = { ...req.session, user_id: userId };
  await req.app.locals.redis.set(sessionKey(req.tenant.id, req.sessionId), JSON.stringify(data), { KEEPTTL: true });
  req.session = data;
}

// Middleware: sets req.session when a valid user session exists for this tenant.
async function loadUserSession(req, res, next) {
  try {
    const id = req.signedCookies?.[COOKIE_NAME];
    if (id) {
      const raw = await req.app.locals.redis.get(sessionKey(req.tenant.id, id));
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.role === "user" && data.tenant_id === req.tenant.id) {
        req.session = data;
        req.sessionId = id;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

// For routes that need a logged-in user with a profile. Use after loadUserSession.
function requireUser(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "not_authenticated" });
  if (!req.session.user_id) return res.status(409).json({ error: "needs_profile" });
  next();
}

async function destroyUserSession(req, res) {
  if (req.sessionId) {
    await req.app.locals.redis.del(sessionKey(req.tenant.id, req.sessionId));
  }
  res.clearCookie(COOKIE_NAME, cookieOptions(req.tenant));
}

module.exports = {
  COOKIE_NAME,
  cookieOptions,
  createUserSession,
  setSessionUser,
  loadUserSession,
  requireUser,
  destroyUserSession
};
