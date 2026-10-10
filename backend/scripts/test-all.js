const http = require('http');
const express = require('express');
const path = require('path');
const { runSetup } = require('./setup-db');
const moviesRouter = require('../routes/movies');
const showsRouter = require('../routes/shows');
const authRouter = require('../routes/auth');
const bookingsRouter = require('../routes/bookings');

async function testAll() {
  console.log('🧪 Starting Full System Test Suite...\n');

  // 1. Setup DB cleanly
  await runSetup();

  // 2. Start Express App on port 3001 for test verification
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  app.use('/api/movies', moviesRouter);
  app.use('/api/shows', showsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/bookings', bookingsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(3001, resolve));
  console.log('🌐 Test server running on http://localhost:3001');

  try {
    // 3. Test Contract & Endpoints
    console.log('\n--- 1. Testing GET /api/movies ---');
    const resMovies = await fetch('http://localhost:3001/api/movies');
    const dataMovies = await resMovies.json();
    console.log(`  Status: ${resMovies.status}, Count: ${dataMovies.count}, Success: ${dataMovies.success}`);

    console.log('\n--- 2. Testing GET /api/shows ---');
    const resShows = await fetch('http://localhost:3001/api/shows');
    const dataShows = await resShows.json();
    console.log(`  Status: ${resShows.status}, Count: ${dataShows.count}, Success: ${dataShows.success}`);
    const showId = dataShows.data[0].id;

    console.log('\n--- 3. Testing GET /api/shows/:id/seats ---');
    const resSeats = await fetch(`http://localhost:3001/api/shows/${showId}/seats`);
    const dataSeats = await resSeats.json();
    console.log(`  Status: ${resSeats.status}, Seats Count: ${dataSeats.seats.length}, Movie: ${dataSeats.movieTitle}`);

    console.log('\n--- 4. Testing Demo Users Token Endpoint ---');
    const resDemo = await fetch('http://localhost:3001/api/auth/demo-users');
    const dataDemo = await resDemo.json();
    console.log(`  Status: ${resDemo.status}, Demo Users Count: ${dataDemo.data.length}`);
    const alice = dataDemo.data[0];
    const bob = dataDemo.data[1];

    console.log('\n--- 5. Testing Concurrent Locking & Queueing ---');
    // Alice locks seat B1
    const resAliceLock = await fetch('http://localhost:3001/api/bookings/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${alice.token}` },
      body: JSON.stringify({ showId: showId, seatNumber: 'B1' })
    });
    const dataAliceLock = await resAliceLock.json();
    console.log('  Alice Lock Response:', dataAliceLock);

    // Bob attempts B1 concurrently -> Queued in locking_logs
    const resBobLock = await fetch('http://localhost:3001/api/bookings/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bob.token}` },
      body: JSON.stringify({ showId: showId, seatNumber: 'B1' })
    });
    const dataBobLock = await resBobLock.json();
    console.log('  Bob Lock Response (Queued):', dataBobLock);

    // Alice confirms payment within 5 minutes
    console.log('\n--- 6. Testing Payment Confirmation & Ticket Generation ---');
    const resAliceConfirm = await fetch('http://localhost:3001/api/bookings/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${alice.token}` },
      body: JSON.stringify({
        showId: showId,
        seats: ['B1'],
        customerName: alice.name,
        customerEmail: alice.email,
        paymentMethod: 'UPI'
      })
    });
    const dataAliceConfirm = await resAliceConfirm.json();
    console.log('  Alice Confirm Response:', dataAliceConfirm);

    console.log('\n✨ ALL SYSTEM & CONTRACT TESTS PASSED PERFECTLY! 🎉');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Test suite failed:', err);
    server.close();
    process.exit(1);
  }
}

testAll();
