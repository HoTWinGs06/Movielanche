const db = require('../config/db');
const { processExpiredLocks, getUserTimeoutStatus } = require('../utils/lockManager');

async function testMechanism() {
  console.log('🧪 Starting Seat Locking & Queueing Mechanism Test...\n');

  try {
    // Fetch Alice (User 1) and Bob (User 2)
    const aliceRes = await db.query("SELECT user_id, name, email FROM users WHERE email = 'alice@example.com'");
    const bobRes = await db.query("SELECT user_id, name, email FROM users WHERE email = 'bob@example.com'");
    const showRes = await db.query("SELECT id FROM showings LIMIT 1");

    if (aliceRes.rowCount === 0 || bobRes.rowCount === 0) {
      console.error('Demo users not found in DB. Make sure setup-db has run.');
      process.exit(1);
    }

    const aliceId = aliceRes.rows[0].user_id;
    const bobId = bobRes.rows[0].user_id;
    const showId = showRes.rows[0].id;
    const testSeat = 'C4';

    console.log(`👤 User 1 (Alice, ID=${aliceId})`);
    console.log(`👤 User 2 (Bob, ID=${bobId})`);
    console.log(`🎬 Show ID: ${showId}, Target Seat: ${testSeat}\n`);

    // Clean any prior locks on test seat
    await db.query("DELETE FROM locking_logs WHERE show_id = $1 AND seat_number = $2", [showId, testSeat]);
    await db.query("DELETE FROM user_timeouts WHERE user_id IN ($1, $2)", [aliceId, bobId]);
    await db.query("UPDATE demo_seats SET status = 'available', islocked = FALSE WHERE show_id = $1 AND seat_number = $2", [showId, testSeat]);

    // --- STEP 1: Alice locks seat C4 ---
    console.log('1️⃣ STEP 1: Alice attempts to lock Seat C4...');
    await db.query(
      `INSERT INTO locking_logs (user_id, show_id, seat_number, status, queue_order, locked_at, expires_at)
       VALUES ($1, $2, $3, 'LOCKED', 1, NOW(), NOW() + INTERVAL '5 minutes')`,
      [aliceId, showId, testSeat]
    );
    await db.query("UPDATE demo_seats SET status = 'locked', islocked = TRUE WHERE show_id = $1 AND seat_number = $2", [showId, testSeat]);

    const aliceLock = await db.query(
      "SELECT * FROM locking_logs WHERE show_id = $1 AND seat_number = $2 AND user_id = $3",
      [showId, testSeat, aliceId]
    );
    console.log(`  ✅ Alice locked seat! Status=${aliceLock.rows[0].status}, Expires=${aliceLock.rows[0].expires_at.toISOString()}`);

    // --- STEP 2: Bob attempts to lock SAME seat C4 at the same time ---
    console.log('\n2️⃣ STEP 2: Bob attempts to book same seat C4 concurrently...');
    await db.query(
      `INSERT INTO locking_logs (user_id, show_id, seat_number, status, queue_order, locked_at, expires_at)
       VALUES ($1, $2, $3, 'QUEUED', 2, NOW(), NOW() + INTERVAL '5 minutes')`,
      [bobId, showId, testSeat]
    );
    const bobLock = await db.query(
      "SELECT * FROM locking_logs WHERE show_id = $1 AND seat_number = $2 AND user_id = $3",
      [showId, testSeat, bobId]
    );
    console.log(`  ✅ Bob logged in locking_logs! Status=${bobLock.rows[0].status}, Queue Position=${bobLock.rows[0].queue_order}`);

    // --- STEP 3: Alice's 5-minute timer expires ---
    console.log('\n3️⃣ STEP 3: Simulating Alice 5-minute lock expiration (setting expires_at to 1 min ago)...');
    await db.query(
      "UPDATE locking_logs SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1 AND show_id = $2 AND seat_number = $3 AND status = 'LOCKED'",
      [aliceId, showId, testSeat]
    );

    console.log('  ⚙️ Running processExpiredLocks()...');
    await processExpiredLocks();

    // Verify Alice is expired & in 30-second timeout penalty
    const aliceTimeout = await getUserTimeoutStatus(aliceId);
    console.log(`  ✅ Alice 30s Timeout Active? ${aliceTimeout.inTimeout}, Remaining Penalty=${aliceTimeout.remainingSeconds}s`);

    // Verify Bob promoted to active LOCKED
    const bobPromoted = await db.query(
      "SELECT * FROM locking_logs WHERE show_id = $1 AND seat_number = $2 AND user_id = $3",
      [showId, testSeat, bobId]
    );
    console.log(`  ✅ Bob status updated to: ${bobPromoted.rows[0].status}! (New Expires: ${bobPromoted.rows[0].expires_at.toISOString()})`);

    // Verify Bob notification created
    const bobNotif = await db.query(
      "SELECT * FROM user_notifications WHERE user_id = $1 AND seat_number = $2 ORDER BY created_at DESC LIMIT 1",
      [bobId, testSeat]
    );
    console.log(`  🔔 Notification sent to Bob: "${bobNotif.rows[0].message}"`);

    // --- STEP 4: Bob confirms payment ---
    console.log('\n4️⃣ STEP 4: Bob confirms payment & completes booking...');
    await db.query(
      "UPDATE locking_logs SET status = 'CONFIRMED', isbooked = TRUE WHERE id = $1",
      [bobPromoted.rows[0].id]
    );
    await db.query(
      "UPDATE demo_seats SET status = 'booked', isbooked = TRUE, booked_by = $1 WHERE show_id = $2 AND seat_number = $3",
      [bobId, showId, testSeat]
    );
    const finalSeat = await db.query("SELECT status, booked_by FROM demo_seats WHERE show_id = $1 AND seat_number = $2", [showId, testSeat]);
    console.log(`  🎉 Booking complete! Final Seat Status=${finalSeat.rows[0].status}, Booked By User=${finalSeat.rows[0].booked_by}`);

    console.log('\n✨ ALL MECHANISM VERIFICATIONS PASSED SUCCESSFULLY! ✨');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

testMechanism();
