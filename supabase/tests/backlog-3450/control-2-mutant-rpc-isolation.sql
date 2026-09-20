-- BACKLOG-3450 / CONTROL 2 — THE MUTATION
--
-- Replaces both RPCs with the isolation removed, then runs control 1's two
-- assertions and expects BOTH TO FAIL. A control that has never been made to
-- fail is not a control; this is what makes control 1 mean something.
--
--   report_list_saved_views   : `WHERE v.user_id = v_caller_id` dropped
--   report_delete_saved_view  : the `v_owner_id != v_caller_id` check dropped
--
-- The replacement and the restore are both inside one transaction that ends in
-- ROLLBACK. DDL is transactional in Postgres, so the real functions are back
-- the moment this script ends, whatever it prints. Nothing it writes survives.
--
-- EXPECTED OUTPUT: two `MUTANT RED` notices and `CONTROL 2 PASSED`.
-- If it prints `MUTANT GREEN` for either, control 1 is vacuous and PR 2 must
-- not merge.
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v owner="'<uuid-1>'" -v other="'<uuid-2>'" \
--     -f control-2-mutant-rpc-isolation.sql

\set ON_ERROR_STOP on
BEGIN;

-- ── the mutant list function: no WHERE on user_id ────────────────
CREATE OR REPLACE FUNCTION public.report_list_saved_views(p_report_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_views JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'name', v.name, 'filters', v.filters,
    'metric', v.metric, 'pinned', v.pinned, 'created_at', v.created_at
  ) ORDER BY v.name ASC), '[]'::jsonb)
  INTO v_views
  FROM report_saved_views v
  WHERE v.report_key = p_report_key;   -- MUTATED: user_id isolation removed

  RETURN v_views;
END;
$$;

-- ── the mutant delete function: no owner check ───────────────────
CREATE OR REPLACE FUNCTION public.report_delete_saved_view(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_owner_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT user_id INTO v_owner_id FROM report_saved_views WHERE id = p_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Saved view not found: %', p_id;
  END IF;
  -- MUTATED: the `v_owner_id != v_caller_id` refusal is gone.

  DELETE FROM report_saved_views WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

DO $control$
DECLARE
  k_owner CONSTANT UUID := :owner;
  k_other CONSTANT UUID := :other;
  v_owner_view UUID;
  v_listed JSONB;
  v_leaked BOOLEAN;
  v_deleted BOOLEAN := false;
BEGIN
  ASSERT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = k_owner)
     AND EXISTS (SELECT 1 FROM internal_roles WHERE user_id = k_other)
     AND k_owner IS DISTINCT FROM k_other,
    'CONTROL 2: needs two distinct internal users, as control 1 does';

  PERFORM set_config('request.jwt.claim.sub', k_owner::text, true);
  v_owner_view := (public.report_save_view(
    'iphone-sync', 'CONTROL 2 owner view',
    '{"types":[],"outcomes":[],"platforms":[],"search":"","stalledOnly":false}'::jsonb,
    '{"col":"runs","fn":"count"}'::jsonb, true, NULL
  )->>'id')::uuid;

  PERFORM set_config('request.jwt.claim.sub', k_other::text, true);

  -- Assertion 1 of control 1, against the mutant.
  v_listed := public.report_list_saved_views('iphone-sync');
  v_leaked := EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_listed) e WHERE (e->>'id')::uuid = v_owner_view
  );
  IF v_leaked THEN
    RAISE NOTICE 'MUTANT RED (list): the second user CAN see the owner''s view once the WHERE is dropped — control 1''s list assertion can fail';
  ELSE
    RAISE EXCEPTION 'MUTANT GREEN (list): control 1''s list assertion is VACUOUS — it would pass over an unisolated RPC';
  END IF;

  -- Assertion 2 of control 1, against the mutant.
  BEGIN
    PERFORM public.report_delete_saved_view(v_owner_view);
    v_deleted := true;
  EXCEPTION WHEN OTHERS THEN
    v_deleted := false;
  END;

  IF v_deleted THEN
    RAISE NOTICE 'MUTANT RED (delete): the second user CAN delete the owner''s view once the owner check is dropped — control 1''s delete assertion can fail';
  ELSE
    RAISE EXCEPTION 'MUTANT GREEN (delete): control 1''s delete assertion is VACUOUS';
  END IF;

  RAISE NOTICE 'CONTROL 2 PASSED — both of control 1''s assertions are load-bearing';
END
$control$;

-- The ROLLBACK restores both real functions. Verify after the script ends:
--   select prosrc like '%v.user_id = v_caller_id%' from pg_proc
--   where proname = 'report_list_saved_views';   -- expect t
ROLLBACK;
