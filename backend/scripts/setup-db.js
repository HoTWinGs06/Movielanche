const fs = require('fs');
const path = require('path');
const db = require('../config/db');

async function runSetup() {
  console.log('🚀 Starting Database Setup & Seeding...');

  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
    console.log('📄 Executing db/schema.sql...');
    await db.query(schemaSql);
    console.log('✅ Schema created successfully.');

    const seedSql = fs.readFileSync(path.join(__dirname, '../db/seed.sql'), 'utf8');
    console.log('🌱 Executing db/seed.sql...');
    await db.query(seedSql);
    console.log('✅ Seed data inserted successfully.');

    const moviesCount = await db.query('SELECT COUNT(*) FROM movie_details');
    const showsCount = await db.query('SELECT COUNT(*) FROM showings');
    const seatsCount = await db.query('SELECT COUNT(*) FROM demo_seats');
    const usersCount = await db.query('SELECT COUNT(*) FROM users');

    console.log('\n📊 Database Summary:');
    console.log(`- Users: ${usersCount.rows[0].count}`);
    console.log(`- Movies: ${moviesCount.rows[0].count}`);
    console.log(`- Showings: ${showsCount.rows[0].count}`);
    console.log(`- Seats: ${seatsCount.rows[0].count}`);
    console.log('🎉 Database setup & dummy data seeding complete!\n');
    return true;
  } catch (err) {
    console.error('❌ Database setup failed:', err);
    throw err;
  }
}

if (require.main === module) {
  runSetup().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { runSetup };
