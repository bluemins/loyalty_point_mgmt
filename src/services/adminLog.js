const { tenantQuery } = require("../db/tenantDb");

// Records an admin change. Call it with the same client as the change itself,
// inside its transaction, so a change is never saved without its log row.
async function writeAdminLog(client, tenantId, { adminId, action, entityType = null, entityId = null, details = {} }) {
  await tenantQuery(
    client,
    tenantId,
    `INSERT INTO admin_action_log (tenant_id, admin_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [adminId, action, entityType, entityId, JSON.stringify(details)]
  );
}

module.exports = { writeAdminLog };
