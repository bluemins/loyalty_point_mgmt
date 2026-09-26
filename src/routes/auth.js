const express = require("express");
const { env } = require("../config/env");
const { normalizePhone } = require("../services/phone");
const otp = require("../services/otp");
const session = require("../services/session");

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
    await session.createUserSession(req.app.locals.redis, res, req.tenant, phone);
    res.json({ ok: true, phone });
  } catch (error) {
    sendOtpError(res, error, next);
  }
});

router.get("/session", session.loadUserSession, (req, res) => {
  if (!req.session) return res.json({ authenticated: false });
  res.json({ authenticated: true, phone: req.session.phone_e164 });
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
