const path = require("path");
const express = require("express");
const auth = require("../services/adminAuth");
const data = require("../services/adminData");
const rewards = require("../services/rewards");
const { adjustPoints } = require("../services/ledger");
const { AppError } = require("../services/errors");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- API ----------

const api = express.Router();

// Changes must be JSON. With the SameSite=Strict cookie this blocks
// cross-site form posts (a form cannot send application/json).
api.use((req, res, next) => {
  if (req.method !== "GET" && !req.is("application/json")) {
    return res.status(415).json({ error: "json_required" });
  }
  next();
});

// Wraps a handler so AppErrors become JSON responses and others go to the
// app's error handler.
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.status).json({ error: error.code, ...error.extra });
      }
      next(error);
    }
  };
}

// Ids in the path must be UUIDs; anything else is simply not found.
function uuidParam(name) {
  return (req, res, next) => (UUID.test(req.params[name]) ? next() : res.status(404).json({ error: "not_found" }));
}

api.post(
  "/login",
  handle(async (req, res) => {
    const { db, redis } = req.app.locals;
    const admin = await auth.login({ db, redis }, { email: req.body?.email, password: req.body?.password, ip: req.ip });
    await auth.startSession(redis, res, admin);
    res.json({ email: admin.email, role: admin.role, tenants: await auth.tenantsFor(db, admin) });
  })
);

api.post(
  "/logout",
  auth.loadAdmin,
  handle(async (req, res) => {
    await auth.endSession(req, res);
    res.json({ ok: true });
  })
);

api.get(
  "/me",
  auth.loadAdmin,
  auth.requireAdmin,
  handle(async (req, res) => {
    res.json({ email: req.admin.email, role: req.admin.role, tenants: await auth.tenantsFor(req.app.locals.db, req.admin) });
  })
);

// Everything below is scoped to one tenant the admin may access.
const tenantApi = express.Router({ mergeParams: true });
api.use("/t/:slug", auth.loadAdmin, auth.requireAdmin, auth.resolveAdminTenant, tenantApi);

tenantApi.get(
  "/users",
  handle(async (req, res) => {
    res.json(await data.listUsers(req.app.locals.db, req.tenant.id, req.query));
  })
);

tenantApi.get(
  "/users/:userId",
  uuidParam("userId"),
  handle(async (req, res) => {
    res.json(await data.getUser(req.app.locals.db, req.tenant.id, req.params.userId));
  })
);

tenantApi.post(
  "/users/:userId/adjust",
  uuidParam("userId"),
  handle(async (req, res) => {
    const amount = req.body?.amount;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) {
      throw new AppError(400, "invalid_amount");
    }
    if (reason.length < 3 || reason.length > 200) throw new AppError(400, "reason_required");
    res.json(
      await adjustPoints(req.app.locals.db, {
        tenantId: req.tenant.id,
        userId: req.params.userId,
        amount,
        reason,
        adminId: req.admin.id
      })
    );
  })
);

tenantApi.get(
  "/ledger",
  handle(async (req, res) => {
    const userId = UUID.test(req.query.user || "") ? req.query.user : null;
    res.json(await data.listLedger(req.app.locals.db, req.tenant.id, { ...req.query, userId }));
  })
);

tenantApi.get(
  "/redemptions",
  handle(async (req, res) => {
    res.json(await data.listRedemptions(req.app.locals.db, req.tenant.id, req.query));
  })
);

tenantApi.post(
  "/redemptions/:redemptionId/fulfil",
  uuidParam("redemptionId"),
  handle(async (req, res) => {
    res.json(
      await rewards.fulfilRedemption(req.app.locals.db, {
        tenantId: req.tenant.id,
        redemptionId: req.params.redemptionId,
        audit: { adminId: req.admin.id }
      })
    );
  })
);

tenantApi.post(
  "/redemptions/:redemptionId/cancel",
  uuidParam("redemptionId"),
  handle(async (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 200) throw new AppError(400, "reason_required");
    res.json(
      await rewards.cancelRedemption(req.app.locals.db, {
        tenantId: req.tenant.id,
        redemptionId: req.params.redemptionId,
        cancelledBy: req.admin.id,
        audit: { adminId: req.admin.id, reason }
      })
    );
  })
);

tenantApi.get(
  "/settings",
  handle(async (req, res) => {
    res.json(await data.getAdminSettings(req.app.locals.db, req.tenant, req.admin.role));
  })
);

tenantApi.put(
  "/settings",
  handle(async (req, res) => {
    res.json(await data.updateSettings(req.app.locals.db, req.tenant, req.admin, req.body));
  })
);

tenantApi.get(
  "/rewards",
  handle(async (req, res) => {
    res.json({ rewards: await data.listAdminRewards(req.app.locals.db, req.tenant.id) });
  })
);

tenantApi.post(
  "/rewards",
  handle(async (req, res) => {
    res.status(201).json(await data.createReward(req.app.locals.db, req.tenant.id, req.admin, req.body));
  })
);

tenantApi.put(
  "/rewards/:rewardId",
  uuidParam("rewardId"),
  handle(async (req, res) => {
    res.json(await data.updateReward(req.app.locals.db, req.tenant.id, req.admin, req.params.rewardId, req.body));
  })
);

// ---------- page ----------

const page = express.Router();
page.get("/", (req, res) => res.sendFile(path.join(__dirname, "../views/admin.html")));

module.exports = { api, tenantApi, page };
