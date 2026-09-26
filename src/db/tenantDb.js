// Every tenant-owned query goes through here. The tenant id is always bound
// as $1, and the SQL must filter or insert on tenant_id, so a query can never
// run without tenant scope.
function tenantQuery(db, tenantId, sql, params = []) {
  if (!tenantId) {
    throw new Error("tenantQuery: tenant_id is required");
  }
  if (!/\btenant_id\b/.test(sql) || !/\$1\b/.test(sql)) {
    throw new Error("tenantQuery: SQL must use tenant_id bound as $1");
  }
  return db.query(sql, [tenantId, ...params]);
}

module.exports = { tenantQuery };
