const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const db = require('../config/db');
const { isPlainObject, withinBcryptLimit, MAX_NAME_LENGTH } = require('../config/validate');

const router = express.Router();

const ACCESS_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;
const JWT_SECRET = process.env.JWT_SECRET || 'movielanche_default_secret_key_2026';

function signAccessToken(user) {
  const userId = user.user_id || user.id;
  const email = user.email_id || user.email;
  return jwt.sign(
    { sub: String(userId), name: user.name, email: email, typ: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL_SECONDS }
  );
}

function publicUser(row) {
  const userId = row.user_id || row.id;
  const userEmail = row.email_id || row.email;
  return {
    id: String(userId),
    user_id: userId,
    name: row.name,
    email: userEmail,
    email_id: userEmail,
    text: row.text || '',
    created_at: row.created_at
  };
}

/** Bearer token authentication middleware */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Missing or malformed Authorization header' },
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: String(payload.sub), name: payload.name, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' },
    });
  }
}

// GET /api/auth/demo-users — helper to get tokens for Alice and Bob for easy frontend testing
router.get('/demo-users', async (req, res) => {
  try {
    const usersRes = await db.query(
      `SELECT user_id, name, email_id, email FROM users ORDER BY user_id ASC LIMIT 3`
    );
    const demoUsers = usersRes.rows.map((u) => {
      const userObj = { user_id: u.user_id, name: u.name, email: u.email };
      const token = signAccessToken(userObj);
      return {
        id: String(u.user_id),
        name: u.name,
        email: u.email,
        token: token
      };
    });
    return res.json({ success: true, data: demoUsers });
  } catch (err) {
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, email_id, password, text } = req.body || {};
  const targetEmail = (email || email_id || '').trim();

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Name is required' } });
  }
  if (!targetEmail || !EMAIL_RE.test(targetEmail)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A valid email is required' } });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const inserted = await db.query(
      `INSERT INTO users (name, email_id, email, password_hash, text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, name, email_id, email, text, created_at`,
      [name.trim(), targetEmail.toLowerCase(), targetEmail.toLowerCase(), passwordHash, text || '']
    );

    const user = inserted.rows[0];
    const userPayload = publicUser(user);
    const token = signAccessToken(user);

    return res.status(201).json({
      success: true,
      token,
      accessToken: token,
      user: userPayload,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email is already registered' } });
    }
    console.error('Registration error:', err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Registration failed' } });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, email_id, password } = req.body || {};
  const targetEmail = (email || email_id || '').trim();

  if (!targetEmail || !password) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Email and password are required' } });
  }

  try {
    const found = await db.query(
      'SELECT user_id, name, email_id, email, text, password_hash FROM users WHERE email_id = $1 OR email = $1',
      [targetEmail.toLowerCase()]
    );

    if (found.rowCount === 0) {
      // Still pay the bcrypt cost, otherwise response time reveals which
      // emails are registered.
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const ok = await bcrypt.compare(password, found.rows[0].password_hash);
    if (!ok) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const user = found.rows[0];
    const userPayload = publicUser(user);
    const token = signAccessToken(user);

    return res.json({
      success: true,
      token,
      accessToken: token,
      user: userPayload,
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Login failed' } });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const found = await db.query(
      'SELECT user_id, name, email_id, email, text, created_at FROM users WHERE user_id = $1',
      [req.user.id]
    );

    if (found.rowCount === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    return res.json({
      success: true,
      user: publicUser(found.rows[0]),
    });
  } catch (err) {
    console.error('Fetch me error:', err.message);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch user' } });
  }
});

module.exports = router;
module.exports.requireAuth = requireAuth;