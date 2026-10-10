-- BACKLOG-3862 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names; no id literals in this directory.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3862:' || p_name)::uuid $f$;
CREATE TEMP TABLE t3862_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3862_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), p_detail) $f$;
