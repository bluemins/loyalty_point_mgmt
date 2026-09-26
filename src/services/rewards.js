const crypto = require("crypto");
const { tenantQuery } = require("../db/tenantDb");
const { getSettings } = require("./tenants");
const { getSpendableCredits } = require("./ledger");

// No 0/O or 1/I, so codes are easy to read out over the phone.
const VOUCHER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIST_LIMIT = 50;

class RewardError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function generateVoucherCode() {
  let raw = "";
  for (let i = 0; i < 10; i++) raw += VOUCHER_ALPHABET[crypto.randomInt(VOUCHER_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

function formatRedemption(row) {
  return {
    id: row.id,
    reward: { id: row.reward_id, name: row.reward_name, type: row.reward_type, image_url: row.reward_image_url },
    points_spent: row.points_spent,
    status: row.status,
    voucher_code: row.voucher_code,
    voucher_expires_at: row.voucher_expires_at,
    created_at: row.created_at
  };
}

const REDEMPTION_SELECT = `
  SELECT r.id, r.user_id, r.reward_id, r.points_spent, r.status, r.voucher_code,
         r.voucher_expires_at, r.created_at,
         rw.name AS reward_name, rw.type AS reward_type, rw.image_url AS reward_image_url
  FROM redemptions r
  JOIN rewards rw ON rw.tenant_id = r.tenant_id AND rw.id = r.reward_id`;

// Stock counts are internal; the catalog only says whether a reward is available.
async function listRewards(db, tenantId) {
  const result = await tenantQuery(
    db,
    tenantId,
    `SELECT id, type, name, description, image_url, points_cost, stock > 0 AS in_stock
     FROM rewards
     WHERE tenant_id = $1 AND active = true
     ORDER BY points_cost, name`
  );
  return result.rows;
}

async function listRedemptions(db, tenantId, userId) {
  const result = await tenantQuery(
    db,
    tenantId,
    `${REDEMPTION_SELECT}
     WHERE r.tenant_id = $1 AND r.user_id = $2
     ORDER BY r.created_at DESC
     LIMIT $3`,
    [userId, LIST_LIMIT]
  );
  return result.rows.map(formatRedemption);
}

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

// The user row lock is the same one scan merges and the expiry job take, so
// everything that changes a user's points runs one at a time per user.
function lockUser(client, tenantId, userId) {
  return tenantQuery(client, tenantId, "SELECT id FROM users WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [userId]);
}

async function findByIdempotencyKey(client, tenantId, key) {
  const result = await tenantQuery(
    client,
    tenantId,
    `${REDEMPTION_SELECT} WHERE r.tenant_id = $1 AND r.idempotency_key = $2`,
    [key]
  );
  return result.rows[0] || null;
}

async function uniqueVoucherCode(client, tenantId) {
  for (;;) {
    const code = generateVoucherCode();
    const taken = await tenantQuery(
      client,
      tenantId,
      "SELECT 1 FROM redemptions WHERE tenant_id = $1 AND voucher_code = $2",
      [code]
    );
    if (taken.rows.length === 0) return code;
  }
}

// Atomic redemption: one transaction, the user row locked, credits spent
// oldest first, and an idempotency key so a double tap or retry returns the
// first result instead of spending again.
async function redeemReward(db, { tenantId, userId, rewardId, idempotencyKey, now = new Date() }) {
  try {
    return await inTransaction(db, async (client) => {
      await lockUser(client, tenantId, userId);

      const existing = await findByIdempotencyKey(client, tenantId, idempotencyKey);
      if (existing) {
        if (existing.user_id !== userId || existing.reward_id !== rewardId) {
          throw new RewardError(409, "idempotency_key_conflict");
        }
        return { redemption: formatRedemption(existing), replayed: true };
      }

      const rewardResult = await tenantQuery(
        client,
        tenantId,
        `SELECT id, name, type, image_url, points_cost, stock, active
         FROM rewards WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [rewardId]
      );
      const reward = rewardResult.rows[0];
      if (!reward || !reward.active) throw new RewardError(404, "reward_not_found");
      if (reward.stock <= 0) throw new RewardError(409, "out_of_stock");

      const credits = await getSpendableCredits(client, tenantId, userId, now);
      const balance = credits.reduce((sum, c) => sum + c.remaining, 0);
      if (balance < reward.points_cost) {
        throw new RewardError(409, "insufficient_points", { balance, points_cost: reward.points_cost });
      }

      const settings = await getSettings(client, tenantId);
      const voucherCode = await uniqueVoucherCode(client, tenantId);
      const inserted = await tenantQuery(
        client,
        tenantId,
        `INSERT INTO redemptions
           (tenant_id, user_id, reward_id, points_spent, status, voucher_code,
            voucher_expires_at, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, 'issued', $5,
                 $6::timestamptz + make_interval(days => $7::int), $8, $6::timestamptz)
         RETURNING id, user_id, reward_id, points_spent, status, voucher_code, voucher_expires_at, created_at`,
        [userId, reward.id, reward.points_cost, voucherCode, now, Number(settings.voucher_validity_days), idempotencyKey]
      );
      const redemption = inserted.rows[0];

      // One debit row per credit drawn from, oldest credit first.
      let toSpend = reward.points_cost;
      for (const credit of credits) {
        if (toSpend === 0) break;
        const take = Math.min(credit.remaining, toSpend);
        await tenantQuery(
          client,
          tenantId,
          `INSERT INTO ledger
             (tenant_id, user_id, type, amount, consumes_ledger_id, reference_type, reference_id, created_at)
           VALUES ($1, $2, 'redeem', $3, $4, 'redemption', $5, $6)`,
          [userId, -take, credit.id, redemption.id, now]
        );
        toSpend -= take;
      }

      await tenantQuery(client, tenantId, "UPDATE rewards SET stock = stock - 1, updated_at = NOW() WHERE tenant_id = $1 AND id = $2", [
        reward.id
      ]);

      return {
        redemption: formatRedemption({
          ...redemption,
          reward_name: reward.name,
          reward_type: reward.type,
          reward_image_url: reward.image_url
        }),
        replayed: false
      };
    });
  } catch (error) {
    // Two different users racing with the same key: the unique constraint
    // stops the second insert.
    if (error.code === "23505" && error.constraint === "redemptions_tenant_id_idempotency_key_key") {
      throw new RewardError(409, "idempotency_key_conflict");
    }
    throw error;
  }
}

async function lockRedemption(client, tenantId, redemptionId) {
  const owner = await tenantQuery(client, tenantId, "SELECT user_id FROM redemptions WHERE tenant_id = $1 AND id = $2", [
    redemptionId
  ]);
  if (!owner.rows[0]) throw new RewardError(404, "redemption_not_found");

  // Same lock order as redemption: user first, then the redemption row.
  await lockUser(client, tenantId, owner.rows[0].user_id);
  const result = await tenantQuery(
    client,
    tenantId,
    `SELECT id, user_id, reward_id, points_spent, status FROM redemptions
     WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [redemptionId]
  );
  return result.rows[0];
}

// Only an issued voucher can be fulfilled. Fulfilled is final.
async function fulfilRedemption(db, { tenantId, redemptionId, now = new Date() }) {
  return inTransaction(db, async (client) => {
    const redemption = await lockRedemption(client, tenantId, redemptionId);
    if (redemption.status !== "issued") {
      throw new RewardError(409, "invalid_status", { status: redemption.status });
    }
    await tenantQuery(
      client,
      tenantId,
      "UPDATE redemptions SET status = 'fulfilled', fulfilled_at = $3 WHERE tenant_id = $1 AND id = $2",
      [redemptionId, now]
    );
    return { id: redemptionId, status: "fulfilled" };
  });
}

// Only an issued voucher can be cancelled. The points come back as one new
// 'refund' credit with a fresh expiry, and the reward's stock is restored.
async function cancelRedemption(db, { tenantId, redemptionId, cancelledBy = null, now = new Date() }) {
  return inTransaction(db, async (client) => {
    const redemption = await lockRedemption(client, tenantId, redemptionId);
    if (redemption.status !== "issued") {
      throw new RewardError(409, "invalid_status", { status: redemption.status });
    }

    const settings = await getSettings(client, tenantId);
    await tenantQuery(
      client,
      tenantId,
      `UPDATE redemptions SET status = 'cancelled', cancelled_at = $3, cancelled_by = $4
       WHERE tenant_id = $1 AND id = $2`,
      [redemptionId, now, cancelledBy]
    );
    await tenantQuery(
      client,
      tenantId,
      `INSERT INTO ledger
         (tenant_id, user_id, type, amount, reference_type, reference_id, expires_at, created_at)
       VALUES ($1, $2, 'refund', $3, 'redemption', $4,
               $5::timestamptz + make_interval(days => $6::int), $5::timestamptz)`,
      [redemption.user_id, redemption.points_spent, redemptionId, now, Number(settings.points_expiry_days)]
    );
    await tenantQuery(client, tenantId, "UPDATE rewards SET stock = stock + 1, updated_at = NOW() WHERE tenant_id = $1 AND id = $2", [
      redemption.reward_id
    ]);
    return { id: redemptionId, status: "cancelled", refunded_points: redemption.points_spent };
  });
}

module.exports = {
  RewardError,
  generateVoucherCode,
  listRewards,
  listRedemptions,
  redeemReward,
  fulfilRedemption,
  cancelRedemption
};
