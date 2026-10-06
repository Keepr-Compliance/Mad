-- G3: the catalogue after the 3725 file equals the pinned post fingerprint (the apply plan's post-check)
SELECT pg_temp.ok((SELECT count(*) FROM post3725_after) = 42, 'post fingerprint row count');
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM pg_temp.fp3725() EXCEPT SELECT * FROM post3725_after)
              AND NOT EXISTS (SELECT * FROM post3725_after EXCEPT SELECT * FROM pg_temp.fp3725()), 'G3 after = pinned');
