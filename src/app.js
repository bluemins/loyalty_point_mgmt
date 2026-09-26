const express = require("express");
const { env } = require("./config/env");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ service: env.APP_NAME, status: "ok" });
});

app.get("/health", async (req, res) => {
  let dbOk = false;
  let redisOk = false;

  if (req.app.locals?.db) {
    try {
      await req.app.locals.db.query("SELECT 1");
      dbOk = true;
    } catch (error) {
      dbOk = false;
    }
  }

  if (req.app.locals?.redis) {
    try {
      await req.app.locals.redis.ping();
      redisOk = true;
    } catch (error) {
      redisOk = false;
    }
  }

  res.json({
    status: dbOk && redisOk ? "ok" : "degraded",
    database: dbOk,
    redis: redisOk,
    app: env.APP_NAME
  });
});

module.exports = app;
