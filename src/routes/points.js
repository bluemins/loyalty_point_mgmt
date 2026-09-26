const express = require("express");
const { getPointsSummary } = require("../services/ledger");
const { loadUserSession, requireUser } = require("../services/session");

const router = express.Router({ mergeParams: true });

router.get("/points", loadUserSession, requireUser, async (req, res, next) => {
  try {
    res.json(await getPointsSummary(req.app.locals.db, req.tenant.id, req.session.user_id));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
