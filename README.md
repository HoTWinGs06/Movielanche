# Movielanche

Movie booking backend for the KLS GIT tech team.

Node + Express + **PostgreSQL**.

---

## Quick start

```bash
# 1. Dependencies
npm install

# 2. Database (Docker — matches the team's existing Postgres setup)
docker run -d --name movielanche-pg \
  -e POSTGRES_DB=movielanche \
  -e POSTGRES_USER=movielanche \
  -e POSTGRES_PASSWORD=movielanche_local_dev \
  -p 5432:5432 postgres:16-alpine

# 3. Config
cp .env.example .env     # edit JWT_SECRET before anything real

# 4. Schema + demo data
npm run db:setup
npm run db:seed

# 5. Run
npm start                # http://localhost:5000
```

Open <http://localhost:5000> for the frontend.

Verify the frontend contract: `npm test` (server must be running).

---

## Database

Apply the files in order — `schema.sql` creates the 8 tables,
`seed.sql` fills them. Both are idempotent, so re-running is safe.

| Seeded | Count |
|---|---|
| Movies | 6 (5 now-showing, 1 coming-soon) |
| Theatres | 3 |
| Shows | 45 (15 per day × 3 days) |
| Seats | 1800 (40 per show: rows A–E, seats 1–8) |
| Pre-booked seats | 10 (locked, so the grid isn't empty) |

The first two shows ship with seats already booked, matching the
"locked seats (seed data)" item in the project plan.

---

## API

All responses are JSON. Errors use `{ "error": { "code", "message" } }`.

### Auth

Access tokens live 15 minutes; refresh tokens live 7 days and **rotate on
every use**. Only SHA-256 hashes are stored. Replaying an already-rotated
token revokes the entire token family and returns `TOKEN_REUSE` — that's
the stolen-token detector.

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | — | 201 + tokens; 409 `EMAIL_TAKEN` if taken |
| POST | `/api/auth/login` | — | 200 + tokens; 401 `INVALID_CREDENTIALS` |
| POST | `/api/auth/refresh` | — | Rotates; 401 `TOKEN_REUSE` on replay |
| POST | `/api/auth/logout` | — | Revokes this session only |
| POST | `/api/auth/logout-all` | Bearer | Revokes every session for the user |

Send the access token as `Authorization: Bearer <token>`.
`token` is also returned as an alias for `accessToken`.

### Catalogue

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/movies` | `?search=&genre=&language=&filter=now_showing\|coming_soon` |
| GET | `/api/movies/near` | `?location=&date=YYYY-MM-DD` — groups by theatre |
| GET | `/api/movies/:id` | Includes `showDates` |
| GET | `/api/movies/:id/shows` | `?date=` required; grouped by theatre |
| GET | `/api/shows/:id/seats` | Flat seat grid with `available`/`booked` |

`GET /api/movies` returns `{ success, count, data[] }` because the committed
frontend reads `data.success` / `data.data`. Movie rows also carry
snake_case aliases (`poster_url`, `release_year`) alongside the camelCase
fields, so `public/app.js` works unmodified.

Unknown locations return an empty list rather than a 404.

### Bookings — all require `Bearer`

| Method | Endpoint | Notes |
|---|---|---|
| POST | `/api/bookings` | `{ showId, seats: ["A1","A2"] }` → 201 + booking |
| GET | `/api/bookings/me` | Newest first |
| GET | `/api/bookings/:id` | 404 unless it belongs to you |

Max 6 seats per booking. Seats must be `A1`–`E8`, no duplicates.
409 `SEAT_UNAVAILABLE` if any seat is already taken.

**How double-booking is prevented:** the whole claim runs in one
transaction that takes a `SELECT … FOR UPDATE` row lock on exactly the
requested seats, in `ORDER BY seat_number` order. Concurrent requests queue
instead of interleaving, and identical lock ordering is what prevents
deadlocks. If any seat is already booked the transaction rolls back and
returns 409. `booking_seats` has a `PRIMARY KEY (show_id, seat_number)`, so
the database itself refuses a second claim even if the code path changes.

Rollback only ever releases seats this request locked — never the caller's
earlier bookings.

---

## Environment

See `.env.example`. Use either `DATABASE_URL` or the individual
`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` variables.

SSL is on automatically for hosted databases (Neon, Supabase, RDS) and off
for local Docker. Never commit `.env`.

---

## Still to do

- TMDB import (titles are seeded locally so a demo never depends on the network)
- Redis caching — deferred per the project plan
- Idempotency keys — not implemented; atomic seat locking already prevents
  duplicate bookings