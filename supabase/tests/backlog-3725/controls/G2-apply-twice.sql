-- G2: the file applied twice leaves the same catalogue as once
-- harness: apply-twice
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM pg_temp.fp3725() EXCEPT SELECT * FROM t3725_once)
              AND NOT EXISTS (SELECT * FROM t3725_once EXCEPT SELECT * FROM pg_temp.fp3725()), 'G2 twice = once');
