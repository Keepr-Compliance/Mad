-- ============================================================================
-- Migration: broker Submissions report rows with several statuses and several agents
-- Backlog: BACKLOG-3513 (broker side, PR-3h). Version granted by the coordinator.
--
--   broker_report_submissions_rows_multi(p_org, p_def, p_statuses text[], p_agents uuid[],
--     p_from, p_to, p_sort, p_limit, p_offset)   NEW. The body of broker_report_submissions_rows
--     (20261112200000 F6) with two filters widened:
--       p_statuses: each value means what p_status means there ('new' = submitted; 'submitted' =
--         submitted + resubmitted; 'pending' = + under_review; else that exact status); the
--         filter is the union of the values. NULL, '{}' or any 'all' in the list = no filter.
--       p_agents: a deal matches when its submitter is in the list. NULL or '{}' = no filter.
--     Everything else is unchanged: SECURITY INVOKER (transaction_submissions RLS applies), STABLE,
--     search_path pinned, scope from broker_report_scope(p_org, p_def) (which checks the caller,
--     the membership and the broker_reports feature, and raises otherwise), no 'uploading' rows,
--     one row per deal, the same sorts, total_count, p_limit clamped to 1-200.
--   broker_report_submissions_rows (the single-value function) is NOT changed; a later release
--     drops it.
--
-- Grants: REVOKE EXECUTE FROM PUBLIC, anon; GRANT EXECUTE TO authenticated (full signature).
-- Pre-pin: stops unless 20261112200000 is recorded and broker_report_scope and
-- broker_report_submissions_rows are at their 20261112200000 bodies, and the new function is
-- absent or already at this file's body (a second run).
-- Idempotent: CREATE OR REPLACE, then REVOKE / GRANT.
-- Rollback: supabase/tests/backlog-3513-multiselect/rollback.sql (drops the new signature only).
-- ============================================================================

DO $pin$
DECLARE r record;
BEGIN
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261112200000') <> 1 THEN
    RAISE EXCEPTION 'BACKLOG-3513 rows multi: 20261112200000 must be applied first';
  END IF;
  FOR r IN
    SELECT v.sig, v.ok, v.may_be_absent, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.broker_report_scope(uuid,uuid)', ARRAY['86899bd79510d5c29d6f33374e1040ff'], false),
        ('public.broker_report_submissions_rows(uuid,uuid,text,uuid,timestamptz,timestamptz,text,integer,integer)',
         ARRAY['922f977f729dd92cfcea89e51fc412ae'], false),
        ('public.broker_report_submissions_rows_multi(uuid,uuid,text[],uuid[],timestamptz,timestamptz,text,integer,integer)',
         ARRAY['08ea53083ce7d6f57a3a735617fcb4ef'], true)
      ) AS v(sig, ok, may_be_absent)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL AND r.may_be_absent THEN
      CONTINUE;
    END IF;
    IF r.cur IS NULL OR NOT (r.cur = ANY (r.ok)) THEN
      RAISE EXCEPTION 'BACKLOG-3513 rows multi: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- ---------------------------------------------------------------------------
-- The Submissions report rows, several statuses and several agents.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_submissions_rows_multi(
  p_org uuid,
  p_def uuid DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_agents uuid[] DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_sort text DEFAULT 'newest',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid,
  submitted_by uuid,
  property_address text,
  property_city text,
  property_state text,
  transaction_type text,
  status text,
  listing_price numeric,
  sale_price numeric,
  created_at timestamptz,
  closed_at timestamptz,
  total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_eff text;
  v_sort text := CASE WHEN p_sort IN ('newest', 'oldest', 'status', 'price_desc', 'price_asc') THEN p_sort ELSE 'newest' END;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_statuses text[];
  v_agents uuid[];
BEGIN
  v_eff := public.broker_report_scope(p_org, p_def) ->> 'effective_scope';
  IF p_statuses IS NOT NULL AND cardinality(p_statuses) > 0 AND NOT coalesce('all' = ANY (p_statuses), false) THEN
    SELECT array_agg(DISTINCT g.st)
      INTO v_statuses
      FROM unnest(p_statuses) AS v(val),
           LATERAL unnest(CASE v.val
             WHEN 'new' THEN ARRAY['submitted']
             WHEN 'submitted' THEN ARRAY['submitted', 'resubmitted']
             WHEN 'pending' THEN ARRAY['submitted', 'resubmitted', 'under_review']
             ELSE ARRAY[v.val] END) AS g(st)
     WHERE v.val IS NOT NULL;
  END IF;
  IF p_agents IS NOT NULL AND cardinality(p_agents) > 0 THEN
    v_agents := p_agents;
  END IF;
  RETURN QUERY
  SELECT s.id, s.submitted_by, s.property_address, s.property_city, s.property_state,
         s.transaction_type::text, s.status::text, s.listing_price, s.sale_price, s.created_at, s.closed_at,
         count(*) OVER ()
    FROM public.transaction_submissions s
   WHERE s.organization_id = p_org
     AND s.status <> 'uploading'
     AND (v_eff = 'all' OR s.submitted_by = v_uid)
     AND NOT EXISTS (
           SELECT 1 FROM public.transaction_submissions c
            WHERE c.parent_submission_id = s.id
              AND c.status <> 'uploading'
              AND c.organization_id = p_org
              AND (v_eff = 'all' OR c.submitted_by = v_uid))
     AND (v_statuses IS NULL OR s.status::text = ANY (v_statuses))
     AND (v_agents IS NULL OR s.submitted_by = ANY (v_agents))
     AND (p_from IS NULL OR s.created_at >= p_from)
     AND (p_to IS NULL OR s.created_at < p_to)
   ORDER BY
     CASE WHEN v_sort = 'status' THEN array_position(
       ARRAY['submitted', 'resubmitted', 'under_review', 'needs_changes', 'approved', 'rejected'], s.status::text) END NULLS LAST,
     CASE WHEN v_sort = 'price_desc' THEN coalesce(nullif(s.sale_price, 0), s.listing_price) END DESC NULLS LAST,
     CASE WHEN v_sort = 'price_asc' THEN coalesce(nullif(s.sale_price, 0), s.listing_price) END ASC NULLS LAST,
     CASE WHEN v_sort = 'oldest' THEN s.created_at END ASC,
     CASE WHEN v_sort = 'oldest' THEN s.id END ASC,
     s.created_at DESC, s.id DESC
   LIMIT v_limit OFFSET v_offset;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.broker_report_submissions_rows_multi(uuid, uuid, text[], uuid[], timestamptz, timestamptz, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_report_submissions_rows_multi(uuid, uuid, text[], uuid[], timestamptz, timestamptz, text, integer, integer) TO authenticated;
