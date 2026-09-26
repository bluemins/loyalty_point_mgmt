const express = require("express");
const scans = require("../services/scans");
const { loadUserSession } = require("../services/session");
const { readDeviceHash, ensureDeviceHash } = require("../services/device");

const router = express.Router({ mergeParams: true });

// POST, not GET: link previews, scanner apps and prefetch can fetch a URL
// without a person scanning, and those must not count as scans. The QR's
// GET /t/:slug/scan will serve the landing page, which calls this.
router.post("/scan", loadUserSession, async (req, res, next) => {
  try {
    // A verified phone without a profile yet still scans as anonymous.
    const userId = req.session?.user_id || null;
    const deviceHash = userId ? readDeviceHash(req) : ensureDeviceHash(req, res);

    const result = await scans.recordScan(req.app.locals, {
      tenant: req.tenant,
      userId,
      deviceHash,
      ip: req.ip,
      userAgent: req.get("user-agent") || null
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
