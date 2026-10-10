const { Pool, types } = require('pg');
require('dotenv').config();

/**
 * Postgres DATE (OID 1082) is a calendar date with no time and no timezone, but
 * node-pg's default parser builds a JS Date at *local* midnight. On a server
 * east of UTC (IST is +05:30) .toISOString() then shifts it back a day, so a
 * show on the 9th is served to the client as the 8th.
 *
 * Returning the raw 'YYYY-MM-DD' string removes the conversion entirely -- the
 * right fix is to never let a timezone-free column become an instant.
 * TIMESTAMPTZ (created_at) keeps the default Date parser, since that one is a
 * real point in time and should serialise as ISO.
 */
types.setTypeParser(1082, (value) => value);

const dbUser = process.env.DB_USERNAME;
const dbPassword = process.env.PASSWORD;
const dbHost = process.env.HOST;
const dbPort = parseInt(process.env.PORT || 5432,10);
const dbName = process.env.DB_NAME;

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        user: dbUser,
        host: dbHost,
        database: dbName,
        password: dbPassword,
        port: dbPort,
        ssl: { rejectUnauthorized: false }
      }
);

pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

async function connect() {
  const res = await pool.query('SELECT 1 AS ok');
  return res.rows[0].ok === 1;
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool, connect
};
