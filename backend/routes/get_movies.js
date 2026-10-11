const express = require('express');
const db = require('../config/db');

const router = express.Router();

async function getMovies(id) {
    const sql = 'SELECT * FROM movie_details WHERE movie_id = $1';
    const result = await db.query(sql, [id]);
    return result.rows[0];
}

(async () => {
    const movie = await getMovies(2);
    console.log(movie);
})();

// module.exports = { getMovies };