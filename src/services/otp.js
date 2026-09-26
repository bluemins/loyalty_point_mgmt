const { env } = require("../config/env");
const { tenantQuery } = require("../db/tenantDb");
const { getSettings } = require("./tenants");
const msg91 = require("./msg91");

const OTP_EXPIRY_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;

class OtpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Redis is the control layer: it holds the live OTP state (attempt count and
// the audit row id) and expires it after 5 minutes. Postgres keeps the audit trail.
function otpKey(tenantId, phone) {
  return `otp:${tenantId}:${phone}`;
}

// Tenant settings override the env defaults for MSG91 sender and template.
function resolveMsg91Ids(settings) {
  return {
    senderId: settings.msg91_sender_id || env.MSG91_SENDER_ID,
    templateId: settings.msg91_template_id || env.MSG91_TEMPLATE_ID
  };
}

// Fixed-window counter. Returns seconds until reset when over the limit, else 0.
async function hitRateLimit(redis, key, limit, windowMinutes) {
  const [count] = await redis
    .multi()
    .incr(key)
    .expire(key, windowMinutes * 60, "NX")
    .exec();
  if (count <= limit) return 0;
  return Math.max(await redis.ttl(key), 1);
}

async function sendOtp({ db, redis, msg91Config }, { tenant, phone, ip }) {
  const settings = await getSettings(db, tenant.id);

  const ipRetry = await hitRateLimit(
    redis,
    `rl:otp:ip:${tenant.id}:${ip}`,
    Number(settings.otp_send_limit_per_ip),
    Number(settings.otp_send_window_ip_minutes)
  );
  const phoneRetry = await hitRateLimit(
    redis,
    `rl:otp:phone:${tenant.id}:${phone}`,
    Number(settings.otp_send_limit_per_phone),
    Number(settings.otp_send_window_phone_minutes)
  );
  const retryAfter = Math.max(ipRetry, phoneRetry);
  if (retryAfter > 0) {
    throw new OtpError(429, "rate_limited", { retry_after_seconds: retryAfter });
  }

  const { senderId, templateId } = resolveMsg91Ids(settings);
  let result;
  try {
    result = await msg91.sendOtp({
      authKey: msg91Config.authKey,
      fetchImpl: msg91Config.fetchImpl,
      senderId,
      templateId,
      phoneE164: phone,
      expiryMinutes: OTP_EXPIRY_MINUTES
    });
  } catch (error) {
    throw new OtpError(502, "otp_provider_unavailable");
  }
  if (!result.ok) throw new OtpError(502, "otp_send_failed");

  const audit = await tenantQuery(
    db,
    tenant.id,
    `INSERT INTO otp_requests (tenant_id, phone_e164, send_count, expires_at, ip_address, status)
     VALUES ($1, $2, 1, NOW() + make_interval(mins => $3), $4, 'pending')
     RETURNING id`,
    [phone, OTP_EXPIRY_MINUTES, ip]
  );

  // A new send replaces any previous OTP and resets the attempt count.
  const key = otpKey(tenant.id, phone);
  await redis
    .multi()
    .del(key)
    .hSet(key, { attempts: 0, request_id: audit.rows[0].id })
    .expire(key, OTP_EXPIRY_MINUTES * 60)
    .exec();

  return { expiresInSeconds: OTP_EXPIRY_MINUTES * 60, mock: Boolean(result.mock) };
}

async function markRequest(db, tenantId, requestId, status, attempts) {
  await tenantQuery(
    db,
    tenantId,
    `UPDATE otp_requests
     SET status = $3,
         attempt_count = $4,
         verified_at = CASE WHEN $3 = 'verified' THEN NOW() ELSE verified_at END
     WHERE tenant_id = $1 AND id = $2`,
    [requestId, status, attempts]
  );
}

async function verifyOtp({ db, redis, msg91Config }, { tenant, phone, otp }) {
  if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    throw new OtpError(400, "invalid_otp_format");
  }

  // Increment and read in one round trip. If request_id is missing the OTP has
  // expired (or was never sent), and HINCRBY just created a stray key: drop it.
  const key = otpKey(tenant.id, phone);
  const [attempts, requestId] = await redis
    .multi()
    .hIncrBy(key, "attempts", 1)
    .hGet(key, "request_id")
    .exec();
  if (!requestId) {
    await redis.del(key);
    throw new OtpError(410, "otp_expired");
  }

  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await markRequest(db, tenant.id, requestId, "locked", MAX_VERIFY_ATTEMPTS);
    throw new OtpError(429, "too_many_attempts");
  }

  let result;
  try {
    result = await msg91.verifyOtp({
      authKey: msg91Config.authKey,
      fetchImpl: msg91Config.fetchImpl,
      phoneE164: phone,
      otp
    });
  } catch (error) {
    throw new OtpError(502, "otp_provider_unavailable");
  }

  if (!result.ok) {
    await markRequest(db, tenant.id, requestId, "pending", attempts);
    throw new OtpError(401, "invalid_otp", { attempts_left: MAX_VERIFY_ATTEMPTS - attempts });
  }

  await redis.del(key);
  await markRequest(db, tenant.id, requestId, "verified", attempts);
}

module.exports = {
  OTP_EXPIRY_MINUTES,
  MAX_VERIFY_ATTEMPTS,
  OtpError,
  otpKey,
  resolveMsg91Ids,
  sendOtp,
  verifyOtp
};
