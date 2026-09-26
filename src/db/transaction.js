const { tenantQuery } = require("./tenantDb");

async function inTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Every change to a user's points (scan merge, redemption, cancel, expiry job,
// admin adjustment) takes this row lock first, so they run one at a time per user.
function lockUser(client, tenantId, userId) {
  return tenantQuery(client, tenantId, "SELECT id FROM users WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [userId]);
}

module.exports = { inTransaction, lockUser };
