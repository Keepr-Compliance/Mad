-- G1: rollback-3403.sql returns the catalogue to the production fingerprint
-- harness: rollback
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM pg_temp.fp3403() EXCEPT SELECT * FROM t3403_before)
              AND NOT EXISTS (SELECT * FROM t3403_before EXCEPT SELECT * FROM pg_temp.fp3403()), 'G1 after rollback = before');
