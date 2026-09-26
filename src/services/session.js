const crypto = require("crypto");
const { env } = require("../config/env");

// User sessions live in Redis so logout and bans take effect immediately.
// The cookie only carries a random session id, signed with SESSION_SECRET.
const COOKIE_NAME = "sid";
const TTL_SECONDS = env.SESSION_TTL_DAYS * 24 * 60 * 60;

function sessionKey(id) {
  return `sess:${id}`;
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

async function createUserSession(redis, res, tenant, phoneE164) {
  const id = crypto.randomBytes(32).toString("base64url");
  const data = {
    role: "user",
    tenant_id: tenant.id,
    phone_e164: phoneE164,
    created_at: new Date().toISOString()
  };
  await redis.set(sessionKey(id), JSON.stringify(data), { EX: TTL_SECONDS });
  res.cookie(COOKIE_NAME, id, { ...cookieOptions(tenant), maxAge: TTL_SECONDS * 1000 });
  return data;
}

// Middleware: sets req.session when a valid user session exists for this tenant.
async function loadUserSession(req, res, next) {
  try {
    const id = req.signedCookies?.[COOKIE_NAME];
    if (id) {
      const raw = await req.app.locals.redis.get(sessionKey(id));
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

async function destroyUserSession(req, res) {
  if (req.sessionId) {
    await req.app.locals.redis.del(sessionKey(req.sessionId));
  }
  res.clearCookie(COOKIE_NAME, cookieOptions(req.tenant));
}

module.exports = { COOKIE_NAME, createUserSession, loadUserSession, destroyUserSession };
