const express = require("express");
const cookieParser = require("cookie-parser");
const { env } = require("./config/env");
const { resolveTenant } = require("./services/tenants");
const authRoutes = require("./routes/auth");

const app = express();

// Railway sits behind one proxy hop; trust it so req.ip is the real client IP
// for rate limiting. Not enabled locally, where X-Forwarded-For could be spoofed.
if (env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(express.json());
app.use(cookieParser(env.SESSION_SECRET));

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

app.use("/t/:slug", resolveTenant, authRoutes);

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "internal_error" });
});

module.exports = app;
