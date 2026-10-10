/**
 * Test route for PostgreSQL connection, check your .env file for the correct values.
 * Use control + c to stop the server after testing.
 */

const {Pool} = require('pg');
require('dotenv').config({ override: true });  
const express = require('express');

const pool = new Pool({
    user: process.env.DB_USERNAME,
    host: process.env.HOST,
    database: process.env.DB_NAME,
    password: process.env.PASSWORD,
    port: parseInt(process.env.PORT || '5432', 10),
    ssl: { rejectUnauthorized: false }
});

const app = new express();
app.use(express.json());
async function testConnection() {
    try {
        console.log('Testing database connection...');

        const result = await pool.query('SELECT movie_name FROM movie_details LIMIT 1');

        console.log('Connected successfully!');
        console.log('Movie name:', result);
    } catch (error) {
        console.error('Database connection failed:', error);
    }
}

testConnection();
