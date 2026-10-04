-- G0: the venue before the 3725 file (prelude + the applied 3403 file) equals production now (the 3403 post-apply fingerprint, matched on production at apply)
SELECT pg_temp.ok((SELECT count(*) FROM post3403_after) = 39, 'pinned 39 rows');
SELECT pg_temp.ok(NOT EXISTS (SELECT * FROM t3725_before EXCEPT SELECT * FROM post3403_after)
              AND NOT EXISTS (SELECT * FROM post3403_after EXCEPT SELECT * FROM t3725_before), 'before = production');
