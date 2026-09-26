const { tenantQuery } = require("../db/tenantDb");
const { getSettings } = require("./tenants");

// Scan days reset at midnight IST. IST has no daylight saving, so a fixed
// +5:30 offset is exact.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
// Cap keys carry the date, so this TTL only needs to outlive the day.
const CAP_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

function istDate(now) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function scanSettings(settings) {
  return {
    pointsPerScan: Number(settings.points_per_scan),
    cooldownMinutes: Number(settings.scan_cooldown_minutes),
    dailyCap: Number(settings.daily_scan_cap),
    expiryDays: Number(settings.points_expiry_days),
    pendingTtlDays: Number(settings.pending_points_ttl_days)
  };
}

// Redis keys are per verified user when logged in, otherwise per device.
function subject(userId, deviceHash) {
  return userId ? `u:${userId}` : `d:${deviceHash}`;
}

function cooldownKey(tenantId, who) {
  return `scan:cd:${tenantId}:${who}`;
}

function capKey(tenantId, who, day) {
  return `scan:cap:${tenantId}:${who}:${day}`;
}

// Decides the outcome using Redis. Only a scan that earns points (or pending
// points) starts the cooldown and uses up the daily cap.
async function checkLimits(redis, tenantId, { userId, deviceHash }, now, cfg) {
  const who = subject(userId, deviceHash);
  const cdKey = cooldownKey(tenantId, who);
  // A logged-in scan also honours the device's cooldown, so "scan anonymously,
  // log in, scan again" cannot earn twice within one cooldown window.
  const deviceCdKey = userId && deviceHash ? cooldownKey(tenantId, subject(null, deviceHash)) : null;
  const cooldownSeconds = cfg.cooldownMinutes * 60;

  if (cooldownSeconds > 0) {
    if (deviceCdKey) {
      const deviceTtl = await redis.ttl(deviceCdKey);
      if (deviceTtl > 0) return { allowed: false, outcome: "cooldown", retryAfter: deviceTtl };
    }
    const set = await redis.set(cdKey, "1", { NX: true, EX: cooldownSeconds });
    if (set === null) {
      return { allowed: false, outcome: "cooldown", retryAfter: await redis.ttl(cdKey) };
    }
  }

  const key = capKey(tenantId, who, istDate(now));
  const [count] = await redis.multi().incr(key).expire(key, CAP_KEY_TTL_SECONDS, "NX").exec();
  if (count > cfg.dailyCap) {
    await redis.multi().decr(key).del(cdKey).exec();
    return { allowed: false, outcome: "capped" };
  }

  if (deviceCdKey && cooldownSeconds > 0) {
    await redis.set(deviceCdKey, "1", { EX: cooldownSeconds });
  }
  return { allowed: true };
}

async function insertScanEvent(db, tenantId, row) {
  const result = await tenantQuery(
    db,
    tenantId,
    `INSERT INTO scan_events
       (tenant_id, user_id, device_token_hash, ip_address, user_agent, outcome,
        points_awarded, points_pending, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      row.userId,
      row.deviceHash,
      row.ip,
      row.userAgent,
      row.outcome,
      row.pointsAwarded || 0,
      row.pointsPending || 0,
      row.now
    ]
  );
  return result.rows[0].id;
}

async function insertScanCredit(db, tenantId, { userId, amount, scanEventId, now, expiryDays }) {
  await tenantQuery(
    db,
    tenantId,
    `INSERT INTO ledger
       (tenant_id, user_id, type, amount, reference_type, reference_id, expires_at, created_at)
     VALUES ($1, $2, 'scan', $3, 'scan_event', $4,
             $5::timestamptz + make_interval(days => $6::int), $5::timestamptz)`,
    [userId, amount, scanEventId, now, expiryDays]
  );
}

async function pendingPoints(db, tenantId, deviceHash, now, pendingTtlDays) {
  if (!deviceHash) return 0;
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT COALESCE(SUM(points_pending), 0)::int AS total
     FROM scan_events
     WHERE tenant_id = $1 AND device_token_hash = $2 AND outcome = 'pending'
       AND created_at > $3::timestamptz - make_interval(days => $4::int)`,
    [deviceHash, now, pendingTtlDays]
  );
  return result.rows[0].total;
}

async function getPendingPoints({ db }, { tenant, deviceHash, now = new Date() }) {
  const cfg = scanSettings(await getSettings(db, tenant.id));
  return pendingPoints(db, tenant.id, deviceHash, now, cfg.pendingTtlDays);
}

function scanMessage(outcome, points, retryAfter) {
  switch (outcome) {
    case "credited":
      return `+${points} points added to your account.`;
    case "pending":
      return `+${points} points pending. Verify your phone to claim them.`;
    case "cooldown": {
      const minutes = Math.max(1, Math.ceil(retryAfter / 60));
      return `You scanned recently. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    }
    default:
      return "You've reached today's scan limit. Come back tomorrow!";
  }
}

// userId is set for a logged-in user with a profile; otherwise the scan is
// anonymous and held as pending against deviceHash.
async function recordScan({ db, redis }, { tenant, userId, deviceHash, ip, userAgent, now = new Date() }) {
  const cfg = scanSettings(await getSettings(db, tenant.id));
  const limits = await checkLimits(redis, tenant.id, { userId, deviceHash }, now, cfg);
  const base = { userId, deviceHash, ip, userAgent, now };

  let outcome;
  let points = 0;

  if (!limits.allowed) {
    outcome = limits.outcome;
    await insertScanEvent(db, tenant.id, { ...base, outcome });
  } else if (userId) {
    outcome = "credited";
    points = cfg.pointsPerScan;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const scanEventId = await insertScanEvent(client, tenant.id, {
        ...base,
        outcome,
        pointsAwarded: points
      });
      await insertScanCredit(client, tenant.id, {
        userId,
        amount: points,
        scanEventId,
        now,
        expiryDays: cfg.expiryDays
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    outcome = "pending";
    points = cfg.pointsPerScan;
    await insertScanEvent(db, tenant.id, { ...base, outcome, pointsPending: points });
  }

  const result = { outcome, points, message: scanMessage(outcome, points, limits.retryAfter) };
  if (outcome === "cooldown") result.retry_after_seconds = limits.retryAfter;
  if (!userId) {
    result.pending_points = await pendingPoints(db, tenant.id, deviceHash, now, cfg.pendingTtlDays);
  }
  return result;
}

// Moves a device's unclaimed pending scans onto a user. Each scan day is still
// held to the daily cap, counting what the user already earned that day, so
// scanning on several devices cannot bypass the cap. Runs in one transaction
// with the pending rows locked, so the same scans can never be merged twice.
async function mergePending({ db, redis }, { tenant, userId, deviceHash, now = new Date() }) {
  const empty = { points: 0, credited: 0, capped: 0 };
  if (!deviceHash) return empty;

  const cfg = scanSettings(await getSettings(db, tenant.id));
  const client = await db.connect();
  let creditedToday = 0;
  let summary;

  try {
    await client.query("BEGIN");

    // Serialises concurrent merges for the same user from different devices.
    await tenantQuery(client, tenant.id, "SELECT id FROM users WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [
      userId
    ]);

    const pending = await tenantQuery(
      client,
      tenant.id,
      `SELECT id, points_pending,
              to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS scan_day
       FROM scan_events
       WHERE tenant_id = $1 AND device_token_hash = $2 AND outcome = 'pending'
         AND created_at > $3::timestamptz - make_interval(days => $4::int)
       ORDER BY created_at
       FOR UPDATE`,
      [deviceHash, now, cfg.pendingTtlDays]
    );
    if (pending.rows.length === 0) {
      await client.query("COMMIT");
      return empty;
    }

    const days = [...new Set(pending.rows.map((row) => row.scan_day))];
    const used = await tenantQuery(
      client,
      tenant.id,
      `SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS scan_day,
              COUNT(*)::int AS credited
       FROM scan_events
       WHERE tenant_id = $1 AND user_id = $2 AND outcome = 'credited'
         AND to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') = ANY($3::text[])
       GROUP BY 1`,
      [userId, days]
    );
    const usedByDay = Object.fromEntries(used.rows.map((row) => [row.scan_day, row.credited]));

    summary = { points: 0, credited: 0, capped: 0 };
    const today = istDate(now);

    for (const row of pending.rows) {
      const usedSoFar = usedByDay[row.scan_day] || 0;
      const credit = usedSoFar < cfg.dailyCap;

      await tenantQuery(
        client,
        tenant.id,
        `UPDATE scan_events
         SET outcome = $3, user_id = $4, points_awarded = $5, claimed_at = $6
         WHERE tenant_id = $1 AND id = $2`,
        [row.id, credit ? "credited" : "capped", userId, credit ? row.points_pending : 0, now]
      );

      if (credit) {
        await insertScanCredit(client, tenant.id, {
          userId,
          amount: row.points_pending,
          scanEventId: row.id,
          now,
          expiryDays: cfg.expiryDays
        });
        usedByDay[row.scan_day] = usedSoFar + 1;
        summary.points += row.points_pending;
        summary.credited += 1;
        if (row.scan_day === today) creditedToday += 1;
      } else {
        summary.capped += 1;
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Keep the live Redis counter in step, so today's merged scans count
  // toward the user's cap for the rest of the day.
  if (creditedToday > 0) {
    const key = capKey(tenant.id, subject(userId), istDate(now));
    await redis.multi().incrBy(key, creditedToday).expire(key, CAP_KEY_TTL_SECONDS, "NX").exec();
  }

  return summary;
}

module.exports = { istDate, recordScan, mergePending, getPendingPoints };
