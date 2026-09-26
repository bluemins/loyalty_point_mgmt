const crypto = require("crypto");
const { tenantQuery } = require("../db/tenantDb");
const { getSettings } = require("./tenants");

const ACTIVITY_LIMIT = 50;

// One row per credit with what is left of it after the debits drawn from it.
// Callers append their own filters and must end with GROUP BY c.id.
const CREDITS_WITH_REMAINING = `
  SELECT c.id, c.user_id, c.expires_at,
         (c.amount + COALESCE(SUM(d.amount), 0))::int AS remaining
  FROM ledger c
  LEFT JOIN ledger d ON d.tenant_id = c.tenant_id AND d.consumes_ledger_id = c.id
  WHERE c.tenant_id = $1 AND c.amount > 0`;

// Balance = what is left of every credit that has not expired yet. A lapsed
// credit drops out at its expires_at, even before the nightly job runs.
async function getBalance(db, tenantId, userId, now) {
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT COALESCE(SUM(remaining), 0)::int AS balance
     FROM (${CREDITS_WITH_REMAINING}
             AND c.user_id = $2 AND c.expires_at > $3
           GROUP BY c.id) credits`,
    [userId, now]
  );
  return result.rows[0].balance;
}

async function getExpiringSoon(db, tenantId, userId, now, withinDays) {
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT to_char(expires_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS date,
            SUM(remaining)::int AS points
     FROM (${CREDITS_WITH_REMAINING}
             AND c.user_id = $2 AND c.expires_at > $3
             AND c.expires_at <= $3::timestamptz + make_interval(days => $4::int)
           GROUP BY c.id) credits
     WHERE remaining > 0
     GROUP BY 1
     ORDER BY 1`,
    [userId, now, withinDays]
  );
  const byDate = result.rows;
  return {
    total: byDate.reduce((sum, row) => sum + row.points, 0),
    within_days: withinDays,
    by_date: byDate
  };
}

// Credits are listed one by one. Debit rows are grouped back into the event
// that wrote them (one redemption, one expiry run), since a single event can
// be split across several credits.
async function getActivity(db, tenantId, userId) {
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT type, SUM(amount)::int AS amount, MIN(created_at) AS created_at,
            MIN(expires_at) AS expires_at
     FROM ledger
     WHERE tenant_id = $1 AND user_id = $2
     GROUP BY type,
              CASE WHEN amount < 0 THEN reference_type || ':' || reference_id ELSE id::text END
     ORDER BY MIN(created_at) DESC
     LIMIT $3`,
    [userId, ACTIVITY_LIMIT]
  );
  return result.rows;
}

async function getPointsSummary(db, tenantId, userId, now = new Date()) {
  const settings = await getSettings(db, tenantId);
  const [balance, expiringSoon, activity] = await Promise.all([
    getBalance(db, tenantId, userId, now),
    getExpiringSoon(db, tenantId, userId, now, Number(settings.expiring_soon_days)),
    getActivity(db, tenantId, userId)
  ]);
  return { balance, expiring_soon: expiringSoon, activity };
}

// Writes one 'expire' row per lapsed credit for exactly what is left of it.
// Each user is handled in its own transaction holding the user row lock (the
// same lock merge and redemption take), so running twice changes nothing.
async function expireLapsedCredits(db, tenantId, now = new Date()) {
  const candidates = await tenantQuery(
    db,
    tenantId,
    `SELECT DISTINCT user_id
     FROM (${CREDITS_WITH_REMAINING} AND c.expires_at <= $2 GROUP BY c.id) credits
     WHERE remaining > 0`,
    [now]
  );

  const summary = { users: 0, credits: 0, points: 0 };

  for (const { user_id: userId } of candidates.rows) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await tenantQuery(client, tenantId, "SELECT id FROM users WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [
        userId
      ]);

      const lapsed = await tenantQuery(
        client,
        tenantId,
        `SELECT id, remaining
         FROM (${CREDITS_WITH_REMAINING} AND c.user_id = $2 AND c.expires_at <= $3 GROUP BY c.id) credits
         WHERE remaining > 0`,
        [userId, now]
      );

      // One reference per user per run, so activity shows it as one event.
      const runId = crypto.randomUUID();
      for (const credit of lapsed.rows) {
        await tenantQuery(
          client,
          tenantId,
          `INSERT INTO ledger
             (tenant_id, user_id, type, amount, consumes_ledger_id, reference_type, reference_id, created_at)
           VALUES ($1, $2, 'expire', $3, $4, 'expiry_run', $5, $6)
           ON CONFLICT (consumes_ledger_id) WHERE type = 'expire' DO NOTHING`,
          [userId, -credit.remaining, credit.id, runId, now]
        );
        summary.credits += 1;
        summary.points += credit.remaining;
      }

      await client.query("COMMIT");
      if (lapsed.rows.length > 0) summary.users += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return summary;
}

module.exports = { ACTIVITY_LIMIT, getBalance, getPointsSummary, expireLapsedCredits };
