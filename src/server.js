const app = require("./app");
const { env } = require("./config/env");
const { pool, redis, pingServices } = require("./db");

async function start() {
  await pingServices();

  app.locals.db = pool;
  app.locals.redis = redis;

  const port = Number(env.PORT) || 3000;

  app.listen(port, () => {
    console.log(`Loyalty API listening on port ${port}`);
  });
}

start().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
