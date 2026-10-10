-- Movielanche seed data
-- Rebuilds catalogues, show timings, seats, and demo users.

TRUNCATE bookings, booking_seats, user_notifications, user_timeouts, locking_logs, demo_seats, showings, theatres_details, movie_details, users RESTART IDENTITY CASCADE;

-- 1. Insert Demo Users (password is 'password123' hashed with bcrypt)
INSERT INTO users (name, email_id, email, password_hash, text) VALUES
('Alice Smith', 'alice@example.com', 'alice@example.com', '$2a$10$X8fP0w3R8Jq5L1n8zX4b2eJ6eK7u8v9w0x1y2z3a4b5c6d7e8f9g0', 'Demo User 1'),
('Bob Johnson', 'bob@example.com', 'bob@example.com', '$2a$10$X8fP0w3R8Jq5L1n8zX4b2eJ6eK7u8v9w0x1y2z3a4b5c6d7e8f9g0', 'Demo User 2'),
('Charlie Brown', 'charlie@example.com', 'charlie@example.com', '$2a$10$X8fP0w3R8Jq5L1n8zX4b2eJ6eK7u8v9w0x1y2z3a4b5c6d7e8f9g0', 'Demo User 3');

-- 2. Insert Movies into movie_details
INSERT INTO movie_details (movie_title, description, genres, genre, language, duration_min, release_date, release_year, poster_url, image_url, rating, director, "IMDB_score", status) VALUES
('Inception', 'A thief who steals corporate secrets through dream-sharing is offered a chance to erase his criminal record if he can plant an idea.',
 ARRAY['Sci-Fi','Thriller','Action'], 'Sci-Fi', 'English', 148, '2010-07-16', 2010, '/posters/inception.jpg', '/posters/inception.jpg', 'PG-13', 'Christopher Nolan', 8.8, 'now_showing'),

('Interstellar', 'A team of explorers travel through a wormhole in space in an attempt to ensure humanity''s survival.',
 ARRAY['Sci-Fi','Drama','Adventure'], 'Sci-Fi', 'English', 169, '2014-11-07', 2014, '/posters/interstellar.jpg', '/posters/interstellar.jpg', 'PG-13', 'Christopher Nolan', 8.7, 'now_showing'),

('RRR', 'A fictional 1920s story about two legendary revolutionaries fighting against foreign invaders.',
 ARRAY['Action','Drama','Musical'], 'Action', 'Telugu', 187, '2022-03-25', 2022, '/posters/rrr.jpg', '/posters/rrr.jpg', 'R', 'S.S. Rajamouli', 8.3, 'now_showing'),

('Kantara', 'A young man discovers a divine form that can undo the chaos of the modern world in a sacred forest.',
 ARRAY['Action','Drama','Fantasy'], 'Action', 'Kannada', 168, '2022-09-30', 2022, '/posters/kantara.jpg', '/posters/kantara.jpg', 'PG-13', 'Rishab Shetty', 8.1, 'now_showing'),

('Dune: Part Two', 'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family.',
 ARRAY['Sci-Fi','Adventure'], 'Sci-Fi', 'English', 166, '2024-03-01', 2024, '/posters/dune2.jpg', '/posters/dune2.jpg', 'PG-13', 'Denis Villeneuve', 8.5, 'now_showing'),

('Kalki 2898 AD', 'A modern avatar of Vishnu descends to Earth to protect the world from dark powers in a post-apocalyptic future.',
 ARRAY['Sci-Fi','Action','Drama'], 'Sci-Fi', 'Telugu', 175, '2024-06-27', 2024, '/posters/kalki.jpg', '/posters/kalki.jpg', 'PG-13', 'Nag Ashwin', 7.6, 'coming_soon');

-- 3. Insert Theatres into theatres_details
INSERT INTO theatres_details (name, location) VALUES
('PVR Forum Mall', 'Downtown'),
('INOX Garuda Mall', 'Central District'),
('Cinepolis Marvel', 'Uptown Heights'),
('IMAX Orion Mall', 'Suburban Hub');

-- 4. Generate Show Timings and Seats for Today, Tomorrow, and Day After
DO $$
DECLARE
  m RECORD;
  t RECORD;
  d INTEGER;
  slot INTEGER;
  base_price NUMERIC(10,2);
  st TIME;
  show_id_var INTEGER;
BEGIN
  FOR m IN SELECT movie_id, duration_min FROM movie_details WHERE status = 'now_showing' LOOP
    FOR d IN 0..2 LOOP
      slot := 0;
      FOR t IN SELECT id FROM theatres_details ORDER BY id LOOP
        slot := slot + 1;
        CASE slot
          WHEN 1 THEN st := '10:30'; base_price := 180.00;
          WHEN 2 THEN st := '14:00'; base_price := 220.00;
          WHEN 3 THEN st := '18:30'; base_price := 280.00;
          ELSE         st := '21:45'; base_price := 250.00;
        END CASE;

        INSERT INTO showings (movie_id, theatre_id, date, start_time, screen, price, runtime, max_seats, filled_seats)
        VALUES (m.movie_id, t.id, (CURRENT_DATE + d), st, 'Screen ' || slot, base_price, m.duration_min, 40, 2)
        RETURNING id INTO show_id_var;

        -- 40 seats per show timing: rows A-E, seats 1-8
        INSERT INTO demo_seats (show_id, seat_number, row, cost, status, isbooked, islocked)
        SELECT
          show_id_var,
          chr(65 + r) || c,
          chr(65 + r),
          base_price::int,
          'available',
          FALSE,
          FALSE
        FROM generate_series(0, 4) AS r, generate_series(1, 8) AS c;

      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- 5. Mark a few pre-booked seats for demo visual effect
UPDATE demo_seats SET status = 'booked', isbooked = TRUE
WHERE seat_id IN (
  SELECT seat_id FROM demo_seats
  WHERE show_id IN (SELECT id FROM showings ORDER BY id LIMIT 3)
    AND seat_number IN ('B3', 'B4', 'C5', 'D2')
);

DO $$
BEGIN
  RAISE NOTICE 'Seeded users=%, movies=%, theatres=%, showings=%, seats=%',
    (SELECT COUNT(*) FROM users),
    (SELECT COUNT(*) FROM movie_details),
    (SELECT COUNT(*) FROM theatres_details),
    (SELECT COUNT(*) FROM showings),
    (SELECT COUNT(*) FROM demo_seats);
END $$;