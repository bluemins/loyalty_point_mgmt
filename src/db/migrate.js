const fs = require("fs");
const path = require("path");
const { pool } = require("./index");

async function runMigration() {
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schemaSql);
  console.log("Database migrations applied successfully.");
}

runMigration()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
