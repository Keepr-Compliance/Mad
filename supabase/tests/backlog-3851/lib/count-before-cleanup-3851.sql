-- BACKLOG-3851 r04: membership row count after rollback-3851-m2.sql, before the cleanup.
CREATE TEMP TABLE t3851_count ON COMMIT DROP AS SELECT count(*) AS n FROM public.organization_members;
