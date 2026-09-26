const { pool } = require("../db");
const { expireLapsedCredits } = require("../services/ledger");
const { expireVouchers } = require("../services/rewards");

// Nightly job (scheduled for 00:30 IST in production). Lapsed points already
// drop out of balances at their expires_at; this writes the 'expire' ledger
// rows so the ledger itself records them, and marks vouchers past their date
// as 'expired'. Safe to run any number of times.
async function runExpiry(db, now = new Date()) {
  const tenants = await db.query("SELECT id, slug FROM tenants ORDER BY slug");
  const results = [];
  for (const tenant of tenants.rows) {
    const summary = await expireLapsedCredits(db, tenant.id, now);
    const vouchers = await expireVouchers(db, tenant.id, now);
    results.push({ tenant: tenant.slug, ...summary, vouchers });
  }
  return results;
}

module.exports = { runExpiry };

if (require.main === module) {
  runExpiry(pool)
    .then((results) => {
      for (const r of results) {
        console.log(
          `${r.tenant}: expired ${r.points} points from ${r.credits} credits for ${r.users} users; ${r.vouchers} vouchers`
        );
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error("Expiry job failed:", error);
      process.exit(1);
    });
}
