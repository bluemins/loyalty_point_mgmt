const { Pool } = require("pg");
const { createClient } = require("redis");
const { env } = require("../config/env");

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const redis = createClient({
  url: env.REDIS_URL
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
});

async function pingServices() {
  await pool.query("SELECT 1");
  await redis.connect();
  await redis.ping();
}

module.exports = { pool, redis, pingServices };
