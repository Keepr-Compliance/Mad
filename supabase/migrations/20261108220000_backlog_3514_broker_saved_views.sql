-- ============================================================================
-- Migration: Personal saved views for broker-portal reports
-- Backlog: BACKLOG-3514 (PR-1). Plan: PLAN v1 + v2 on the item (pm_comments).
-- Requires: 20261108140000 (BACKLOG-3505, public._org_feature_allowed and the
--           broker_reports feature) and 20261108190000 (BACKLOG-3511,
--           public.org_report_scope). This version sorts after both.
--
-- What it adds:
--   public.broker_report_saved_views   one row = one user's saved view of one
--                                      report in one organization
--   public.broker_report_list_views    the caller's own views of a report
--   public.broker_report_save_view     create, or update one of the caller's views
--   public.broker_report_delete_view   remove one of the caller's views
--   public.broker_report_set_default_view  make one view the default, or clear it
--
-- Access model:
--   * The table is reachable only through the four functions: RLS on, no
--     policy, every table privilege revoked from anon and authenticated.
--   * Each function checks, in this order: a signed-in caller; the caller's
--     report scope in the view's organization (org_report_scope, which is
--     NULL for non-members, inactive members and personal organizations);
--     the broker_reports feature of that organization; ownership
--     (user_id = auth.uid()); then the inputs (key format, filters size,
--     name length). On update, remove and set-default the organization is
--     the ROW's organization, never the argument.
--   * Every refusal raises the same text: 'Saved view not found'.
--   * A member who leaves keeps their rows; the scope check hides them, and
--     they return when the membership is active again.
--   * organization_id, user_id and report_key never change after insert
--     (trigger), so no update can move a view into another organization.
--   * At most 5 pinned views per (organization, user, report). The count runs
--     under a transaction lock keyed on that triple, so two tabs cannot both
--     count 4 and both pin. A pinned view must carry a metric.
--   * Separate from public.report_saved_views (admin portal): those functions
--     are keyed on user + report key only, so one table would mix portals for
--     a user who is both internal staff and a brokerage member.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE, then REVOKE / GRANT).
-- Rollback: supabase/tests/backlog-3514/rollback-3514.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.broker_report_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_key text NOT NULL CHECK (report_key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  metric jsonb,
  pinned boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_report_saved_views_pin_needs_metric CHECK (NOT pinned OR metric IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS broker_report_saved_views_owner_idx
  ON public.broker_report_saved_views (organization_id, user_id, report_key);
CREATE UNIQUE INDEX IF NOT EXISTS broker_report_saved_views_one_default
  ON public.broker_report_saved_views (organization_id, user_id, report_key) WHERE is_default;

ALTER TABLE public.broker_report_saved_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.broker_report_saved_views FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.broker_report_saved_views IS
  'BACKLOG-3514: personal saved views of broker-portal reports. RPC-only (broker_report_*_view functions).';

-- ---------------------------------------------------------------------------
-- Owner, organization and report never change after insert.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._broker_report_views_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id /*IMMUTABLE_ORG*/
     OR NEW.report_key IS DISTINCT FROM OLD.report_key /*IMMUTABLE_KEY*/
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS broker_report_saved_views_immutable ON public.broker_report_saved_views;
CREATE TRIGGER broker_report_saved_views_immutable
  BEFORE UPDATE ON public.broker_report_saved_views
  FOR EACH ROW EXECUTE FUNCTION public._broker_report_views_immutable();

-- ---------------------------------------------------------------------------
-- Gate on one organization. Scope first, so a non-member learns nothing about
-- the organization's plan. Internal: no role may call it directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._broker_report_views_gate(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND p_org IS NOT NULL
     AND public.org_report_scope(p_org) IS NOT NULL
     AND coalesce(public._org_feature_allowed(p_org, 'broker_reports'), false) /*FEATURE*/
$function$;

-- Inputs shared by save (and the key by list / set-default).
CREATE OR REPLACE FUNCTION public._broker_report_views_key_ok(p_report_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  SELECT p_report_key IS NOT NULL AND p_report_key ~ '^[a-z0-9][a-z0-9-]{0,62}$'
$function$;

-- ---------------------------------------------------------------------------
-- List: the caller's own views of one report in one organization.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_list_views(p_org uuid, p_report_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL OR NOT public._broker_report_views_gate(p_org)
     OR NOT public._broker_report_views_key_ok(p_report_key) THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', v.id,
             'name', v.name,
             'filters', v.filters,
             'metric', v.metric,
             'pinned', v.pinned,
             'is_default', v.is_default,
             'created_at', v.created_at,
             'updated_at', v.updated_at
           ) ORDER BY v.created_at, v.id)
      FROM public.broker_report_saved_views v
     WHERE v.organization_id = p_org
       AND v.report_key = p_report_key
       AND v.user_id = v_uid /*LIST_OWNER*/
  ), '[]'::jsonb);
END
$function$;

-- ---------------------------------------------------------------------------
-- Save: p_id NULL creates a view in p_org; p_id set updates the caller's own
-- view, gated on THAT ROW's organization. p_org and p_report_key are ignored
-- on update (the row's own are immutable).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_save_view(
  p_org uuid,
  p_report_key text,
  p_name text,
  p_filters jsonb,
  p_metric jsonb,
  p_pinned boolean,
  p_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_key text;
  v_pinned boolean := coalesce(p_pinned, false);
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_n int;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT v.organization_id, v.report_key INTO v_org, v_key
      FROM public.broker_report_saved_views v
     WHERE v.id = p_id AND v.user_id = v_uid
       FOR UPDATE;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'Saved view not found';
    END IF;
    v_org := v_org /*UPDATE_ORG*/;
  ELSE
    v_org := p_org;
    v_key := p_report_key;
  END IF;

  IF NOT public._broker_report_views_gate(v_org) THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  IF NOT public._broker_report_views_key_ok(v_key)
     OR jsonb_typeof(v_filters) <> 'object'
     OR pg_column_size(v_filters) > 16384
     OR (p_metric IS NOT NULL AND (jsonb_typeof(p_metric) <> 'object' OR pg_column_size(p_metric) > 1024))
     OR coalesce(btrim(p_name), '') = ''
     OR length(btrim(p_name)) > 120
     OR (v_pinned AND p_metric IS NULL) THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  IF v_pinned THEN
    -- Held to the end of the transaction: a second save for the same owner
    -- and report waits here, then counts what the first one committed.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('broker_report_saved_views:' || v_org::text || ':' || v_uid::text || ':' || v_key, 3514)
    ) /*PIN_LOCK*/;
    SELECT count(*) INTO v_n
      FROM public.broker_report_saved_views
     WHERE organization_id = v_org AND user_id = v_uid AND report_key = v_key
       AND pinned AND id IS DISTINCT FROM p_id;
    IF v_n >= 5 THEN
      RAISE EXCEPTION 'At most 5 pinned cards per report. Unpin one first.';
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.broker_report_saved_views (organization_id, user_id, report_key, name, filters, metric, pinned)
    VALUES (v_org, v_uid, v_key, btrim(p_name), v_filters, p_metric, v_pinned)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.broker_report_saved_views
       SET name = btrim(p_name), filters = v_filters, metric = p_metric, pinned = v_pinned
     WHERE id = p_id AND user_id = v_uid
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id);
END
$function$;

-- ---------------------------------------------------------------------------
-- Remove one of the caller's views, gated on the ROW's organization.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_delete_view(p_org uuid, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;
  SELECT v.organization_id INTO v_org
    FROM public.broker_report_saved_views v
   WHERE v.id = p_id AND v.user_id = v_uid
     FOR UPDATE;
  IF v_org IS NULL OR NOT public._broker_report_views_gate(v_org /*REMOVE_ORG*/) THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;
  DELETE FROM public.broker_report_saved_views WHERE id = p_id AND user_id = v_uid;
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- Default: p_id set -> that view (the caller's, gated on its row org) becomes
-- the only default of its report; p_id NULL -> clear the caller's default of
-- p_report_key in p_org. The others are cleared first, so the partial unique
-- index never surfaces a second error text.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_set_default_view(p_org uuid, p_report_key text, p_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_key text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT v.organization_id, v.report_key INTO v_org, v_key
      FROM public.broker_report_saved_views v
     WHERE v.id = p_id AND v.user_id = v_uid
       FOR UPDATE;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'Saved view not found';
    END IF;
  ELSE
    v_org := p_org;
    v_key := p_report_key;
  END IF;

  IF NOT public._broker_report_views_gate(v_org /*DEFAULT_ORG*/) OR NOT public._broker_report_views_key_ok(v_key) THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  UPDATE public.broker_report_saved_views
     SET is_default = false
   WHERE organization_id = v_org AND user_id = v_uid AND report_key = v_key
     AND is_default AND id IS DISTINCT FROM p_id;

  IF p_id IS NOT NULL THEN
    UPDATE public.broker_report_saved_views SET is_default = true
     WHERE id = p_id AND user_id = v_uid AND NOT is_default;
  END IF;

  RETURN jsonb_build_object('success', true);
END
$function$;

COMMENT ON FUNCTION public.broker_report_list_views(uuid, text) IS
  'BACKLOG-3514: the caller''s own saved views of a broker report in an organization.';
COMMENT ON FUNCTION public.broker_report_save_view(uuid, text, text, jsonb, jsonb, boolean, uuid) IS
  'BACKLOG-3514: create, or update one of the caller''s own saved views (gated on the row''s organization).';
COMMENT ON FUNCTION public.broker_report_delete_view(uuid, uuid) IS
  'BACKLOG-3514: remove one of the caller''s own saved views (gated on the row''s organization).';
COMMENT ON FUNCTION public.broker_report_set_default_view(uuid, text, uuid) IS
  'BACKLOG-3514: make one of the caller''s views the default of its report, or clear the default.';

-- Internal helpers: no direct callers.
REVOKE EXECUTE ON FUNCTION public._broker_report_views_immutable() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._broker_report_views_gate(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._broker_report_views_key_ok(text) FROM PUBLIC, anon, authenticated;

-- The four RPCs: signed-in callers only.
REVOKE EXECUTE ON FUNCTION public.broker_report_list_views(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.broker_report_save_view(uuid, text, text, jsonb, jsonb, boolean, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.broker_report_delete_view(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.broker_report_set_default_view(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_report_list_views(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_save_view(uuid, text, text, jsonb, jsonb, boolean, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_delete_view(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_set_default_view(uuid, text, uuid) TO authenticated;
