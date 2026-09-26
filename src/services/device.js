const crypto = require("crypto");
const { cookieOptions } = require("./session");

// Anonymous scanners are identified by a random device token in a signed cookie.
// Only its hash is stored, so a database leak cannot be replayed as a cookie.
const COOKIE_NAME = "dt";
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readDeviceHash(req) {
  const token = req.signedCookies?.[COOKIE_NAME];
  return token ? hashToken(token) : null;
}

// Returns the device hash, issuing a new device cookie on first visit.
function ensureDeviceHash(req, res) {
  const existing = readDeviceHash(req);
  if (existing) return existing;

  const token = crypto.randomBytes(32).toString("base64url");
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(req.tenant), maxAge: MAX_AGE_MS });
  return hashToken(token);
}

module.exports = { COOKIE_NAME, readDeviceHash, ensureDeviceHash };
