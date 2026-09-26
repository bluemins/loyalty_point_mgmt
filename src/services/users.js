const { tenantQuery } = require("../db/tenantDb");

async function findUserByPhone(db, tenantId, phoneE164) {
  const result = await tenantQuery(
    db,
    tenantId,
    "SELECT id, phone_e164, name, category FROM users WHERE tenant_id = $1 AND phone_e164 = $2",
    [phoneE164]
  );
  return result.rows[0] || null;
}

// If two requests race to create the same phone, the second gets the existing user.
async function createUser(db, tenantId, { phoneE164, name, category }) {
  const result = await tenantQuery(
    db,
    tenantId,
    `INSERT INTO users (tenant_id, phone_e164, name, category, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (tenant_id, phone_e164) DO NOTHING
     RETURNING id, phone_e164, name, category`,
    [phoneE164, name, category]
  );
  return result.rows[0] || findUserByPhone(db, tenantId, phoneE164);
}

module.exports = { findUserByPhone, createUser };
