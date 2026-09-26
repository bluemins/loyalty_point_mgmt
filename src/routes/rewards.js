const express = require("express");
const rewards = require("../services/rewards");
const { loadUserSession, requireUser } = require("../services/session");

const router = express.Router({ mergeParams: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The client generates one key per redeem intent and resends it on retry.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

function sendRewardError(res, error, next) {
  if (error instanceof rewards.RewardError) {
    return res.status(error.status).json({ error: error.code, ...error.extra });
  }
  next(error);
}

// Public: the landing page can show rewards before anyone logs in.
router.get("/rewards", async (req, res, next) => {
  try {
    res.json({ rewards: await rewards.listRewards(req.app.locals.db, req.tenant.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/rewards/:rewardId/redeem", loadUserSession, requireUser, async (req, res, next) => {
  const idempotencyKey = req.get("Idempotency-Key");
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return res.status(400).json({ error: "missing_idempotency_key" });
  }
  if (!UUID.test(req.params.rewardId)) {
    return res.status(404).json({ error: "reward_not_found" });
  }

  try {
    const result = await rewards.redeemReward(req.app.locals.db, {
      tenantId: req.tenant.id,
      userId: req.session.user_id,
      rewardId: req.params.rewardId,
      idempotencyKey
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    sendRewardError(res, error, next);
  }
});

router.get("/redemptions", loadUserSession, requireUser, async (req, res, next) => {
  try {
    res.json({
      redemptions: await rewards.listRedemptions(req.app.locals.db, req.tenant.id, req.session.user_id)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
