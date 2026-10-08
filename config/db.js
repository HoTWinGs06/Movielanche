const { Pool } = require('pg');
// Load .env with override enabled so .env values supersede OS system environment variables (like system USERNAME)
require('dotenv').config({ override: true });

const dbUser = process.env.DB_USER || process.env.USERNAME || 'neondb_owner';
const dbPassword = process.env.DB_PASSWORD || process.env.PASSWORD;
const dbHost = process.env.DB_HOST || process.env.SERVER;
const dbPort = parseInt(process.env.DB_PORT || process.env.HOST || '5432', 10);
const dbName = process.env.DB_NAME || process.env.DBNAME || process.env.DATABASE || 'neondb';

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

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
