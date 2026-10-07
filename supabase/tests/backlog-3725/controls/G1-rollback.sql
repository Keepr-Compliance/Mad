-- G1: rollback-3725.sql returns the catalogue to the 3403 state exactly
-- harness: rollback
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM pg_temp.fp3725() EXCEPT SELECT * FROM t3725_before)
              AND NOT EXISTS (SELECT * FROM t3725_before EXCEPT SELECT * FROM pg_temp.fp3725()), 'G1 after rollback = before');
