-- G3: the catalogue after the migration equals the pinned post fingerprint (the apply plan's post-check)
SELECT pg_temp.ok((SELECT count(*) FROM post3403_after) = 39, 'post fingerprint row count');
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM pg_temp.fp3403() EXCEPT SELECT * FROM post3403_after)
              AND NOT EXISTS (SELECT * FROM post3403_after EXCEPT SELECT * FROM pg_temp.fp3403()), 'G3 after = pinned');
