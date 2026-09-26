const express = require("express");
const { env } = require("../config/env");
const { normalizePhone } = require("../services/phone");
const otp = require("../services/otp");
const session = require("../services/session");
const scans = require("../services/scans");
const users = require("../services/users");
const { getSettings } = require("../services/tenants");
const { readDeviceHash } = require("../services/device");

const router = express.Router({ mergeParams: true });

// app.locals.msg91 lets tests swap in a stub HTTP client; normally env is used.
function deps(req) {
  const { db, redis, msg91 } = req.app.locals;
  return {
    db,
    redis,
    msg91Config: msg91 || { authKey: env.MSG91_AUTH_KEY, fetchImpl: fetch }
  };
}

function sendOtpError(res, error, next) {
  if (error instanceof otp.OtpError) {
    return res.status(error.status).json({ error: error.code, ...error.extra });
  }
  next(error);
}

router.post("/otp/send", async (req, res, next) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "invalid_phone" });

  try {
    const result = await otp.sendOtp(deps(req), { tenant: req.tenant, phone, ip: req.ip });
    const body = { ok: true, phone, expires_in_seconds: result.expiresInSeconds };
    if (result.mock) body.mock = true;
    res.json(body);
  } catch (error) {
    sendOtpError(res, error, next);
  }
});

router.post("/otp/verify", async (req, res, next) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "invalid_phone" });

  try {
    await otp.verifyOtp(deps(req), { tenant: req.tenant, phone, otp: req.body?.otp });

    const { db, redis } = req.app.locals;
    const deviceHash = readDeviceHash(req);
    const user = await users.findUserByPhone(db, req.tenant.id, phone);
    await session.createUserSession(redis, res, req.tenant, phone, user?.id || null);

    // Existing phone: claim this device's pending points now.
    if (user) {
      const merged = await scans.mergePending(req.app.locals, {
        tenant: req.tenant,
        userId: user.id,
        deviceHash
      });
      return res.json({ ok: true, phone, needs_profile: false, merged_points: merged.points });
    }

    // New phone: pending points are claimed once the profile is created.
    const pending = await scans.getPendingPoints(req.app.locals, { tenant: req.tenant, deviceHash });
    res.json({ ok: true, phone, needs_profile: true, pending_points: pending });
  } catch (error) {
    sendOtpError(res, error, next);
  }
});

router.post("/profile", session.loadUserSession, async (req, res, next) => {
  if (!req.session) return res.status(401).json({ error: "not_authenticated" });
  if (req.session.user_id) return res.status(409).json({ error: "profile_exists" });

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return res.status(400).json({ error: "invalid_name" });
  }

  try {
    const { db } = req.app.locals;
    const settings = await getSettings(db, req.tenant.id);
    const categories = Array.isArray(settings.user_categories) ? settings.user_categories : [];
    if (!categories.includes(req.body?.category)) {
      return res.status(400).json({ error: "invalid_category", categories });
    }

    const user = await users.createUser(db, req.tenant.id, {
      phoneE164: req.session.phone_e164,
      name,
      category: req.body.category
    });
    await session.setSessionUser(req, user.id);

    const merged = await scans.mergePending(req.app.locals, {
      tenant: req.tenant,
      userId: user.id,
      deviceHash: readDeviceHash(req)
    });
    res.json({
      ok: true,
      user: { name: user.name, category: user.category, phone: user.phone_e164 },
      merged_points: merged.points
    });
  } catch (error) {
    next(error);
  }
});

router.get("/session", session.loadUserSession, (req, res) => {
  if (!req.session) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    phone: req.session.phone_e164,
    has_profile: Boolean(req.session.user_id)
  });
});

router.post("/logout", session.loadUserSession, async (req, res, next) => {
  try {
    await session.destroyUserSession(req, res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
