const db = require('../config/db');

/**
 * Process expired locks across the system:
 * 1. Finds active locks ('LOCKED') where expires_at <= NOW().
 * 2. Updates their status to 'EXPIRED'.
 * 3. Places the user in a 30-second penalty timeout in user_timeouts.
 * 4. Checks if another user is QUEUED for the seat.
 * 5. If queued user exists, promotes them to 'LOCKED' for 5 mins & sends notification.
 * 6. If no queued user, marks seat as 'available'.
 */
async function processExpiredLocks(clientOrDb = db) {
  const queryFn = clientOrDb.query ? clientOrDb.query.bind(clientOrDb) : db.query.bind(db);

  try {
    // 1. Find expired active locks
    const expiredRes = await queryFn(
      `SELECT id, user_id, show_id, seat_number
       FROM locking_logs
       WHERE status = 'LOCKED' AND expires_at <= NOW()`
    );

    for (const lock of expiredRes.rows) {
      // Mark as EXPIRED
      await queryFn(
        `UPDATE locking_logs SET status = 'EXPIRED' WHERE id = $1`,
        [lock.id]
      );

      // Put user in 30-second penalty timeout
      await queryFn(
        `INSERT INTO user_timeouts (user_id, timeout_until, reason)
         VALUES ($1, NOW() + INTERVAL '30 seconds', '5-minute lock expired without booking')
         ON CONFLICT (user_id) DO UPDATE
         SET timeout_until = NOW() + INTERVAL '30 seconds', created_at = NOW()`,
        [lock.user_id]
      );

      // Check for queued user
      const nextQueued = await queryFn(
        `SELECT id, user_id, show_id, seat_number
         FROM locking_logs
         WHERE show_id = $1 AND seat_number = $2 AND status = 'QUEUED'
         ORDER BY queue_order ASC, created_at ASC
         LIMIT 1`,
        [lock.show_id, lock.seat_number]
      );

      if (nextQueued.rowCount > 0) {
        const queuedLock = nextQueued.rows[0];
        // Promote 2nd person to active LOCKED for 5 mins
        await queryFn(
          `UPDATE locking_logs
           SET status = 'LOCKED', locked_at = NOW(), expires_at = NOW() + INTERVAL '5 minutes', notified_at = NOW()
           WHERE id = $1`,
          [queuedLock.id]
        );

        // Update seat state
        await queryFn(
          `UPDATE demo_seats
           SET status = 'locked', islocked = TRUE, booked_by = $1
           WHERE show_id = $2 AND seat_number = $3`,
          [queuedLock.user_id, lock.show_id, lock.seat_number]
        );

        // Notify 2nd person
        await queryFn(
          `INSERT INTO user_notifications (user_id, show_id, seat_number, message)
           VALUES ($1, $2, $3, $4)`,
          [
            queuedLock.user_id,
            lock.show_id,
            lock.seat_number,
            `🎉 Seat ${lock.seat_number} is now OPEN for you! Your 5-minute booking window has started.`
          ]
        );
      } else {
        // Mark seat as available
        await queryFn(
          `UPDATE demo_seats
           SET status = 'available', islocked = FALSE, booked_by = NULL
           WHERE show_id = $1 AND seat_number = $2 AND status != 'booked'`,
          [lock.show_id, lock.seat_number]
        );
      }
    }

    // Clean up expired timeouts older than current time
    await queryFn(
      `DELETE FROM user_timeouts WHERE timeout_until <= NOW()`
    );
  } catch (err) {
    console.error('Error in processExpiredLocks:', err.message);
  }
}

/**
 * Check if a user is currently in a 30-second penalty timeout.
 */
async function getUserTimeoutStatus(userId, clientOrDb = db) {
  const queryFn = clientOrDb.query ? clientOrDb.query.bind(clientOrDb) : db.query.bind(db);
  const res = await queryFn(
    `SELECT timeout_until,
            EXTRACT(EPOCH FROM (timeout_until - NOW()))::int AS remaining_sec
     FROM user_timeouts
     WHERE user_id = $1 AND timeout_until > NOW()`,
    [userId]
  );

  if (res.rowCount > 0) {
    return {
      inTimeout: true,
      remainingSeconds: Math.max(1, parseInt(res.rows[0].remaining_sec, 10) || 1),
      timeoutUntil: res.rows[0].timeout_until
    };
  }
  return { inTimeout: false, remainingSeconds: 0 };
}

module.exports = {
  processExpiredLocks,
  getUserTimeoutStatus
};
