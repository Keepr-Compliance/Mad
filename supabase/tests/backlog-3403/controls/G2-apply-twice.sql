-- G2: the file applied twice leaves the same catalogue as once
-- harness: apply-twice
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM pg_temp.fp3403() EXCEPT SELECT * FROM t3403_once)
              AND NOT EXISTS (SELECT * FROM t3403_once EXCEPT SELECT * FROM pg_temp.fp3403()), 'G2 twice = once');
