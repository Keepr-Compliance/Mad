-- G0: the venue before the migration equals the production fingerprint
SELECT pg_temp.ok((SELECT count(*) FROM prod3403_before) = 27, 'prod fingerprint has 27 rows');
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM t3403_before EXCEPT SELECT * FROM prod3403_before)
              AND NOT EXISTS (SELECT * FROM prod3403_before EXCEPT SELECT * FROM t3403_before), 'venue before = production');
