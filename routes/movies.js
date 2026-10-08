const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Helper to find tables in public schema
async function getPublicTables() {
  try {
    const res = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    return res.rows.map(r => r.table_name);
  } catch (err) {
    return [];
  }
}

// Find matching movies table or best candidate table
async function getMoviesTable() {
  const tables = await getPublicTables();
  if (tables.length === 0) return 'movies';

  const match = tables.find(t => 
    ['movies', 'movie', 'films', 'film', 'movielanche'].includes(t.toLowerCase())
  );

  return match || tables[0];
}

// GET /api/movies - Fetch all movies from database
router.get('/', async (req, res) => {
  try {
    const tableName = await getMoviesTable();
    
    // Query table dynamically
    const result = await db.query(`SELECT * FROM "${tableName}"`);
    
    res.json({
      success: true,
      tableName: tableName,
      count: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    console.error('Error fetching movies:', err.message);
    const tables = await getPublicTables();

    res.status(500).json({
      success: false,
      error: `Database error: ${err.message}`,
      existingTables: tables,
      hint: tables.length > 0 
        ? `Found tables in your database: [${tables.join(', ')}].`
        : `No tables were found in the connected database. Please create a 'movies' table.`
    });
  }
});

// GET /api/movies/:id - Fetch single movie by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const tableName = await getMoviesTable();
    const result = await db.query(`SELECT * FROM "${tableName}" WHERE id = $1`, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Movie with ID ${id} not found`
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    console.error(`Error fetching movie ${id}:`, err.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch movie details',
      details: err.message
    });
  }
});

module.exports = router;
