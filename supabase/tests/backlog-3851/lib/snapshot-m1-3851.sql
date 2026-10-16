-- BACKLOG-3851 r03/r04: the fingerprint with M1 applied and M2 not yet (= production today),
-- taken between M1 and M2 so the M2-only rollback can be compared to it object by object.
CREATE TEMP TABLE t3851_m1 ON COMMIT DROP AS SELECT k, v FROM pg_temp.venue3851();
SELECT 'SNAPSHOT3851|' || count(*) FROM t3851_m1;
