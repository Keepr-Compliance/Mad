-- BACKLOG-3851 setup harness: the venue after M1 must equal production read on
-- 2026-10-15 (Supabase MCP, ledger head 20261016033654) for every row of
-- ../backlog-3851/lib/fingerprint-3851.sql. Loaded right after M1, before M2 / the
-- new migration. ERROR (psql stops, run reports ERROR) on any difference.
DO $pin$
DECLARE v_fp text;
BEGIN
  SELECT md5(string_agg(k || '|' || v, E'\n' ORDER BY k)) || '|' || count(*) INTO v_fp FROM pg_temp.venue3851();
  IF v_fp IS DISTINCT FROM '685c78e6381c2afbbb4e05dfb4e64f07|41' THEN
    RAISE EXCEPTION 'PINSETUP MISMATCH: venue % <> production 685c78e6381c2afbbb4e05dfb4e64f07|41', v_fp;
  END IF;
END $pin$;
SELECT 'PINSETUP OK';
