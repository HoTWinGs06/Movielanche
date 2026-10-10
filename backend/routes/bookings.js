const crypto = require('crypto');
const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('./auth');
const { processExpiredLocks, getUserTimeoutStatus } = require('../utils/lockManager');

const router = express.Router();

const MAX_SEATS = 6;
const SEAT_RE = /^[A-E][1-8]$/;

function generateBookingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(5);
  let code = '';
  for (const b of bytes) code += chars[b % chars.length];
  return `BMS-${code}`;
}

/**
 * POST /api/bookings/lock (protected)
 * Immediately locks seat for 5 minutes or queues user if locked by someone else.
 */
router.post('/lock', requireAuth, async (req, res) => {
  let { showId, seatNumber, seats } = req.body || {};

  if (!seats && seatNumber) {
    seats = [seatNumber];
  }
  if (!showId || !/^\d+$/.test(String(showId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A valid showId is required' } });
  }
  if (!Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'seats must be a non-empty array' } });
  }
  if (!seats.every((s) => typeof s === 'string' && SEAT_RE.test(s))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Seat numbers must look like A1..E8' } });
  }

  const userId = parseInt(req.user.id, 10);

  // Check 30-second penalty timeout status
  const timeoutStatus = await getUserTimeoutStatus(userId);
  if (timeoutStatus.inTimeout) {
    return res.status(403).json({
      error: {
        code: 'USER_IN_TIMEOUT',
        message: `You are currently in a 30-second penalty timeout because a previous lock expired without payment.`,
        remainingSeconds: timeoutStatus.remainingSeconds,
        timeoutUntil: timeoutStatus.timeoutUntil
      }
    });
  }

  const client = await db.pool.connect();
  let committed = null;
  try {
    await client.query('BEGIN');
    await processExpiredLocks(client);

    const targetSeat = seats[0]; // Primary seat to lock/queue

    // 1. Check if seat is already booked
    const seatCheck = await client.query(
      `SELECT seat_number, status, isbooked FROM demo_seats WHERE show_id = $1 AND seat_number = $2`,
      [showId, targetSeat]
    );

    if (seatCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Seat does not exist for this show' } });
    }

    if (seatCheck.rows[0].status === 'booked' || seatCheck.rows[0].isbooked) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { code: 'SEAT_UNAVAILABLE', message: 'This seat is already booked.' } });
    }

    // 2. Check active lock held on this seat
    const activeLock = await client.query(
      `SELECT id, user_id, status, queue_order, expires_at,
              EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS remaining_sec
       FROM locking_logs
       WHERE show_id = $1 AND seat_number = $2 AND status = 'LOCKED' AND expires_at > NOW()`,
      [showId, targetSeat]
    );

    // Scenario A: Caller already holds the active lock
    if (activeLock.rowCount > 0 && activeLock.rows[0].user_id === userId) {
      await client.query('COMMIT');
      const rem = Math.max(0, parseInt(activeLock.rows[0].remaining_sec, 10) || 300);
      return res.json({
        success: true,
        status: 'LOCKED',
        seatNumber: targetSeat,
        showId: String(showId),
        message: 'You hold the active lock for this seat.',
        remainingSeconds: rem,
        expiresAt: activeLock.rows[0].expires_at
      });
    }

    // Scenario B: Another user holds active lock -> Queue caller as 2nd person
    if (activeLock.rowCount > 0 && activeLock.rows[0].user_id !== userId) {
      // Find max queue order
      const maxQueueRes = await client.query(
        `SELECT COALESCE(MAX(queue_order), 0) AS max_order
         FROM locking_logs
         WHERE show_id = $1 AND seat_number = $2 AND status IN ('LOCKED', 'QUEUED')`,
        [showId, targetSeat]
      );
      const queuePosition = (parseInt(maxQueueRes.rows[0].max_order, 10) || 1) + 1;

      // Check if user is already queued
      const existingQueue = await client.query(
        `SELECT id, queue_order FROM locking_logs
         WHERE show_id = $1 AND seat_number = $2 AND user_id = $3 AND status = 'QUEUED'`,
        [showId, targetSeat, userId]
      );

      let finalPos = queuePosition;
      if (existingQueue.rowCount > 0) {
        finalPos = existingQueue.rows[0].queue_order;
      } else {
        await client.query(
          `INSERT INTO locking_logs (user_id, show_id, seat_number, status, queue_order, locked_at, expires_at)
           VALUES ($1, $2, $3, 'QUEUED', $4, NOW(), NOW() + INTERVAL '5 minutes')`,
          [userId, showId, targetSeat, finalPos]
        );
      }

      await client.query('COMMIT');
      return res.json({
        success: true,
        status: 'QUEUED',
        seatNumber: targetSeat,
        showId: String(showId),
        queuePosition: finalPos,
        message: `Seat ${targetSeat} is currently locked by another user. You are locked in queue (Position #${finalPos}). You will be notified immediately if their 5-minute timer expires!`
      });
    }

    // Scenario C: Seat is available -> Lock seat for current user for 5 minutes
    await client.query(
      `DELETE FROM locking_logs
       WHERE show_id = $1 AND seat_number = $2 AND user_id = $3 AND status IN ('EXPIRED', 'RELEASED')`,
      [showId, targetSeat, userId]
    );

    const insertedLock = await client.query(
      `INSERT INTO locking_logs (user_id, show_id, seat_number, status, queue_order, locked_at, expires_at)
       VALUES ($1, $2, $3, 'LOCKED', 1, NOW(), NOW() + INTERVAL '5 minutes')
       RETURNING id, expires_at`,
      [userId, showId, targetSeat]
    );

    await client.query(
      `UPDATE demo_seats SET status = 'locked', islocked = TRUE, booked_by = $1
       WHERE show_id = $2 AND seat_number = $3`,
      [userId, showId, targetSeat]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      status: 'LOCKED',
      seatNumber: targetSeat,
      showId: String(showId),
      expiresAt: insertedLock.rows[0].expires_at,
      remainingSeconds: 300,
      message: `Seat ${targetSeat} immediately locked! You have 5 minutes to fill details and confirm payment.`
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Lock seat error:', err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to lock seat' } });
  } finally {
    client.release();
  }
});

/**
 * POST /api/bookings/confirm (protected)
 * Confirms payment and finalizes booking within 5-minute window.
 */
router.post('/confirm', requireAuth, async (req, res) => {
  const { showId, seats, customerName, customerEmail, paymentMethod } = req.body || {};

  if (!showId || !/^\d+$/.test(String(showId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A valid showId is required' } });
  }
  if (!Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'seats must be a non-empty array' } });
  }

  const userId = parseInt(req.user.id, 10);
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');
    await processExpiredLocks(client);

    // Verify active lock exists for caller on all requested seats
    const validLocks = await client.query(
      `SELECT seat_number
       FROM locking_logs
       WHERE show_id = $1 AND user_id = $2 AND seat_number = ANY($3::text[])
         AND status = 'LOCKED' AND expires_at > NOW()`,
      [showId, userId, seats]
    );

    if (validLocks.rowCount !== seats.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: {
          code: 'LOCK_EXPIRED',
          message: 'Your 5-minute seat lock has expired or is invalid. Please lock seats again.'
        }
      });
    }

    const showRes = await client.query(
      `SELECT s.price, m.movie_title, t.name AS theatre_name, s.date, s.start_time
       FROM showings s
       JOIN movie_details m ON m.movie_id = s.movie_id
       JOIN theatres_details t ON t.id = s.theatre_id
       WHERE s.id = $1`,
      [showId]
    );

    if (showRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Show not found' } });
    }

    const price = Number(showRes.rows[0].price);
    const totalAmount = price * seats.length;
    const bookingCode = generateBookingCode();

    // 1. Insert into bookings
    const bookingRes = await client.query(
      `INSERT INTO bookings (user_id, show_id, booking_code, seats, customer_name, customer_email, total_amount, status)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7, 'confirmed')
       RETURNING id, booking_code, seats, total_amount, status, created_at`,
      [userId, showId, bookingCode, seats, customerName || req.user.name, customerEmail || req.user.email, totalAmount]
    );

    const bookingId = bookingRes.rows[0].id;

    // 2. Insert into booking_seats & update demo_seats
    for (const seat of seats) {
      await client.query(
        `INSERT INTO booking_seats (booking_id, show_id, seat_number) VALUES ($1, $2, $3)`,
        [bookingId, showId, seat]
      );

      await client.query(
        `UPDATE demo_seats SET status = 'booked', isbooked = TRUE, booked_by = $1
         WHERE show_id = $2 AND seat_number = $3`,
        [userId, showId, seat]
      );

      // 3. Mark caller's lock as CONFIRMED
      await client.query(
        `UPDATE locking_logs SET status = 'CONFIRMED', isbooked = TRUE
         WHERE show_id = $1 AND user_id = $2 AND seat_number = $3 AND status = 'LOCKED'`,
        [showId, userId, seat]
      );

      // 4. Cancel any queued users for this seat & notify them
      const queuedUsers = await client.query(
        `SELECT id, user_id FROM locking_logs
         WHERE show_id = $1 AND seat_number = $2 AND status = 'QUEUED'`,
        [showId, seat]
      );

      for (const q of queuedUsers.rows) {
        await client.query(
          `UPDATE locking_logs SET status = 'CANCELLED' WHERE id = $1`,
          [q.id]
        );

        await client.query(
          `INSERT INTO user_notifications (user_id, show_id, seat_number, message)
           VALUES ($1, $2, $3, $4)`,
          [q.user_id, showId, seat, `Notice: Seat ${seat} was confirmed & purchased by another user.`]
        );
      }
    }

    await client.query('COMMIT');

    const showDetails = showRes.rows[0];

    return res.status(201).json({
      success: true,
      bookingId: String(bookingId),
      bookingCode: bookingCode,
      movie: showDetails.movie_title,
      theatre: showDetails.theatre_name,
      date: showDetails.date instanceof Date ? showDetails.date.toISOString().slice(0, 10) : String(showDetails.date).slice(0, 10),
      startTime: String(showDetails.start_time).slice(0, 5),
      seats: seats,
      totalAmount: totalAmount,
      customerName: customerName || req.user.name,
      paymentMethod: paymentMethod || 'Card / UPI',
      status: 'confirmed',
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Confirm booking error:', err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to confirm booking' } });
  } finally {
    client.release();
  }

  // Past this point the transaction is committed and the client owns a real
  // booking. A failure assembling the response must NOT be reported as a
  // failed booking, or the user retries and is told their own seats are taken.
  try {
    const payload = await buildBookingPayload({ ...committed, show_id: validShowId });
    return res.status(201).json(payload);
  } catch (err) {
    console.error('Booking committed but response build failed:', err.message);
    return res.status(201).json({
      bookingId: String(committed.id),
      bookingCode: committed.booking_code,
      seats: committed.seats,
      totalAmount: Number(committed.total_amount),
      status: committed.status,
      createdAt: committed.created_at,
    });
  }
});

/**
 * POST /api/bookings/release (protected)
 * Releases lock early, promoting 2nd person in queue instantly.
 */
router.post('/release', requireAuth, async (req, res) => {
  const { showId, seatNumber } = req.body || {};
  if (!showId || !seatNumber) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'showId and seatNumber are required' } });
  }

  const userId = parseInt(req.user.id, 10);
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE locking_logs SET status = 'RELEASED'
       WHERE show_id = $1 AND seat_number = $2 AND user_id = $3 AND status IN ('LOCKED', 'QUEUED')`,
      [showId, seatNumber, userId]
    );

    await processExpiredLocks(client);
    await client.query('COMMIT');

    return res.json({ success: true, message: `Lock on seat ${seatNumber} released.` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to release lock' } });
  } finally {
    client.release();
  }
});

/** GET /api/bookings/notifications (protected) */
router.get('/notifications', requireAuth, async (req, res) => {
  const userId = parseInt(req.user.id, 10);
  try {
    await processExpiredLocks();

    const notifications = await db.query(
      `SELECT id, show_id, seat_number, message, is_read, created_at
       FROM user_notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    return res.json({
      success: true,
      data: notifications.rows.map((n) => ({
        id: String(n.id),
        showId: String(n.show_id),
        seatNumber: n.seat_number,
        message: n.message,
        isRead: n.is_read,
        createdAt: n.created_at
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch notifications' } });
  }
});

/** GET /api/bookings/me (protected) */
router.get('/me', requireAuth, async (req, res) => {
  const limitRaw = qString(req.query.limit);
  const offsetRaw = qString(req.query.offset);
  const limit = limitRaw === null ? 25 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'limit must be 1-100' },
    });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'offset must be >= 0' },
    });
  }

  try {
    // Single JOIN instead of one query per booking: the previous shape ran a
    // buildBookingPayload query for every row (N+1).
    const found = await db.query(
      `SELECT b.id, b.show_id, b.booking_code, b.seats, b.total_amount, b.status, b.created_at,
              m.movie_title, t.name AS theatre_name, s.date, s.start_time
       FROM bookings b
       JOIN showings s ON s.id = b.show_id
       JOIN movie_details m ON m.movie_id = s.movie_id
       JOIN theatres_details t ON t.id = s.theatre_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );

    return res.json(
      found.rows.map((r) => ({
        bookingId: String(r.id),
        bookingCode: r.booking_code,
        movie: r.movie_title,
        theatre: r.theatre_name,
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
        startTime: String(r.start_time).slice(0, 5),
        seats: r.seats,
        totalAmount: Number(r.total_amount),
        status: r.status,
        createdAt: r.created_at
      }))
    );
  } catch (err) {
    console.error('My bookings error:', err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch bookings' } });
  }
});

module.exports = router;