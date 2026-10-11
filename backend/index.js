require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./config/db');
const { rateLimit } = require('./config/rateLimit');
const moviesRouter = require('./routes/movies');
const showsRouter = require('./routes/shows');
const authRouter = require('./routes/auth');
const bookingsRouter = require('./routes/bookings');

const app = express();
const PORT = parseInt(3000, 10);
// app.use(
//   helmet({
//     // The default CSP has script-src 'self' + script-src-attr 'none', which
//     // BLOCKS the inline onerror handler the committed public/app.js puts on
//     // every <img> -- posters silently stopped falling back. Two options here:
//     // allow inline attributes (weaker, but keeps the teammate's file working
//     // untouched), or refactor app.js. We are not editing their file, so the
//     // policy accommodates it.
//     contentSecurityPolicy: {
//       directives: {
//         ...helmet.contentSecurityPolicy.getDefaultDirectives(),
//         'script-src': ["'self'", "'unsafe-inline'"],
//         'script-src-attr': ["'unsafe-inline'"],
//         // Poster artwork will come from TMDB once that import lands.
//         'img-src': ["'self'", 'data:', 'https:'],
//       },
//     },
//     // Also stop advertising the framework.
//     hidePoweredBy: true,
//   })
// );
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Rate limits are per-IP and configurable. The defaults are deliberately
// generous enough that teammates sharing one office or campus NAT don't lock
// each other out, while still throttling credential stuffing (bcrypt makes
// each attempt expensive, so this is a DoS control as much as a brute-force
// control).
//
// RATE_LIMIT_MAX is a MULTIPLIER on those defaults, not an on/off switch:
// the previous version only tested it against 0, so setting RATE_LIMIT_MAX=1000
// still returned a ceiling of 40 and made the variable a lie in .env. Set
// RATE_LIMIT_MAX=0 to disable entirely (load testing only).
const isTest = process.env.NODE_ENV === 'test';
const RATE_LIMIT_MAX = isTest ? 0 : Number(process.env.RATE_LIMIT_MAX || '1');
const limit = (windowMs, max, message) => {
  const scaled = Math.max(1, Math.round(max * RATE_LIMIT_MAX));
  return RATE_LIMIT_MAX === 0
    ? (req, res, next) => next()
    : rateLimit({ windowMs, max: scaled, message });
};

// General abuse ceiling on the API surface.
app.use('/api', limit(60 * 1000, 300));


app.get('/api/health', async (req, res) => {
  // Actually query the database. A hardcoded 'connected' meant a load balancer
  // kept routing to an instance whose Postgres was gone -- the endpoint said
  // healthy while every real request 500'd.
  //
  // Never echo err.message: a connection failure carries the hostname, port
  // and database user.
  try {
    await db.query('SELECT 1');
    return res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('Health check failed:', err.message);
    // 503 so orchestrators and load balancers stop sending traffic here.
    return res.status(503).json({ status: 'degraded', database: 'unreachable' });
  }
});

/**
 * TEST-ONLY helper.
 *
 * Ages a refresh token's revoked_at past the reuse-detection grace window so the
 * regression suite can exercise the theft path, which is otherwise unreachable
 * without waiting 30 seconds. Mounted ONLY when NODE_ENV=test, so it cannot
 * exist in a deployed process.
 */
if (isTest) {
  app.post('/_test/age-family/:hash', async (req, res) => {
    try {
      // The raw token from the client is hashed, and the row it identified has
      // already been consumed by the refresh under test -- so match the whole
      // FAMILY it belongs to and push its revoked_at outside the grace window.
      // The path segment is hex(RAW token); the column stores sha256(RAW).
      const raw = Buffer.from(req.params.hash, 'hex').toString('utf8');
      const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
      const r = await db.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '10 minutes'
         WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
        [hash]
      );
      return res.json({ updated: r.rowCount });
    } catch (err) {
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
    }
  });
}


// API routes
app.use('/api/auth', limit(15 * 60 * 1000, 40), authRouter);
app.use('/api/bookings', limit(60 * 1000, 60), bookingsRouter);
app.use('/api/movies', moviesRouter);
app.use('/api/shows', showsRouter);

// Unknown /api paths must return JSON, never the SPA shell
app.use('/api', (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` },
  });
});

// SPA fallback for everything else -- but a request for a real asset that does
// not exist must 404 honestly rather than return index.html with a 200.
app.use((req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
function assertConfig() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set. Copy .env.example to .env and set a strong secret.');
  }
  if (process.env.JWT_SECRET === 'dev-only-change-me' && isProd) {
    throw new Error('JWT_SECRET is still the example value. Generate a real secret before deploying.');
  }
  // A short secret is brute-forceable; HS256 gives no protection against it.
  // Checking only in production kept the same weak value live on every
  // non-production deploy, which is where staging credentials leak from.
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32');
  }
}
// Verify the database at boot
function assertConfig() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set.");
  if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters.");
}
async function main() {
  assertConfig();
  await db.connect();
  console.log('Connected to PostgreSQL');

  const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});