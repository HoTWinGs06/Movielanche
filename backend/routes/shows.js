const express = require('express');
const db = require('../config/db');
const { processExpiredLocks, getUserTimeoutStatus } = require('../utils/lockManager');
const jwt = require('jsonwebtoken');
const { qId } = require('../config/validate');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

function getUserIdFromAuthHeader(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      return payload.sub ? parseInt(payload.sub, 10) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** GET /api/shows — List show timings with movie & theatre info */
router.get('/', async (req, res) => {
  try {
    await processExpiredLocks();

    const result = await db.query(
      `SELECT s.id, s.movie_id, m.movie_title AS title, m.poster_url,
              s.theatre_id, t.name AS theatre_name, t.location,
              s.date, s.start_time, s.screen, s.price, s.runtime, s.max_seats,
              (SELECT COUNT(*) FROM demo_seats ds WHERE ds.show_id = s.id AND ds.status = 'booked')::int AS filled_seats
       FROM showings s
       JOIN movie_details m ON m.movie_id = s.movie_id
       JOIN theatres_details t ON t.id = s.theatre_id
       ORDER BY s.date ASC, s.start_time ASC`
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows.map((r) => ({
        id: String(r.id),
        showId: String(r.id),
        movieId: String(r.movie_id),
        title: r.title,
        posterUrl: r.poster_url,
        theatreId: String(r.theatre_id),
        theatreName: r.theatre_name,
        location: r.location,
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
        startTime: String(r.start_time).slice(0, 5),
        screen: r.screen,
        price: Number(r.price),
        runtime: r.runtime,
        maxSeats: r.max_seats,
        filledSeats: r.filled_seats,
        availableSeats: r.max_seats - r.filled_seats
      }))
    });
  } catch (err) {
    console.error('Error fetching shows:', err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch shows' } });
  }
});

/** GET /api/shows/:id/seats — Flat seat grid with live locking & queueing info */
router.get('/:id/seats', async (req, res) => {
  const id = qId(req.params.id);

  if (id === null) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Show not found' } });
  }

  const userId = getUserIdFromAuthHeader(req);

  try {
    // Process any expired locks before returning seat state
    await processExpiredLocks();

    const show = await db.query(
      `SELECT s.id, s.price, m.movie_title AS title, t.name AS theatre_name, s.date, s.start_time
       FROM showings s
       JOIN movie_details m ON m.movie_id = s.movie_id
       JOIN theatres_details t ON t.id = s.theatre_id
       WHERE s.id = $1`,
      [id]
    );

    if (show.rowCount === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Show not found' } });
    }

    // Check caller's 30-second penalty timeout status
    const userTimeout = userId ? await getUserTimeoutStatus(userId) : { inTimeout: false, remainingSeconds: 0 };

    // Fetch seats
    const seatsRes = await db.query(
      `SELECT seat_id, seat_number, status, cost, isbooked, islocked, booked_by
       FROM demo_seats
       WHERE show_id = $1
       ORDER BY seat_number ASC`,
      [id]
    );

    // Fetch active locking_logs for this show
    const locksRes = await db.query(
      `SELECT id, user_id, seat_number, status, queue_order, locked_at, expires_at,
              EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS remaining_sec
       FROM locking_logs
       WHERE show_id = $1 AND status IN ('LOCKED', 'QUEUED')
       ORDER BY seat_number ASC, queue_order ASC`,
      [id]
    );

    // Map lock entries by seat_number
    const lockMap = {};
    for (const lock of locksRes.rows) {
      if (!lockMap[lock.seat_number]) {
        lockMap[lock.seat_number] = [];
      }
      lockMap[lock.seat_number].push(lock);
    }

    const formattedSeats = seatsRes.rows.map((s) => {
      const seatLocks = lockMap[s.seat_number] || [];
      const activeLock = seatLocks.find((l) => l.status === 'LOCKED');
      const userLock = userId ? seatLocks.find((l) => l.user_id === userId) : null;

      let effectiveStatus = s.status;
      if (s.status !== 'booked') {
        if (activeLock) {
          effectiveStatus = 'locked';
        } else {
          effectiveStatus = 'available';
        }
      }

      let callerState = null;
      let remainingSeconds = 0;
      let expiresAt = null;

      if (userLock) {
        callerState = userLock.status; // 'LOCKED' or 'QUEUED'
        if (userLock.status === 'LOCKED') {
          remainingSeconds = Math.max(0, parseInt(userLock.remaining_sec, 10) || 0);
          expiresAt = userLock.expires_at;
        }
      } else if (activeLock && activeLock.user_id === userId) {
        callerState = 'LOCKED';
        remainingSeconds = Math.max(0, parseInt(activeLock.remaining_sec, 10) || 0);
        expiresAt = activeLock.expires_at;
      }

      const activeLockRemaining = activeLock ? Math.max(0, parseInt(activeLock.remaining_sec, 10) || 0) : 0;

      return {
        seatNumber: s.seat_number,
        status: effectiveStatus,
        cost: s.cost || Number(show.rows[0].price),
        isBooked: s.status === 'booked' || s.isbooked,
        isLocked: effectiveStatus === 'locked',
        lockedByMe: !!userLock && userLock.status === 'LOCKED',
        queuedByMe: !!userLock && userLock.status === 'QUEUED',
        callerLockStatus: callerState,
        lockExpiresAt: activeLock ? activeLock.expires_at : null,
        lockRemainingSeconds: activeLockRemaining,
        callerRemainingSeconds: remainingSeconds,
        queueCount: seatLocks.filter((l) => l.status === 'QUEUED').length,
        myQueuePosition: userLock && userLock.status === 'QUEUED' ? userLock.queue_order : null
      };
    });

    const showDetails = show.rows[0];

    return res.json({
      showId: String(showDetails.id),
      movieTitle: showDetails.title,
      theatreName: showDetails.theatre_name,
      date: showDetails.date instanceof Date ? showDetails.date.toISOString().slice(0, 10) : String(showDetails.date).slice(0, 10),
      startTime: String(showDetails.start_time).slice(0, 5),
      price: Number(showDetails.price),
      userTimeout: userTimeout,
      seats: formattedSeats,
    });
  } catch (err) {
    console.error(`Error fetching seats for show ${id}:`, err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch seats' } });
  }
});

module.exports = router;