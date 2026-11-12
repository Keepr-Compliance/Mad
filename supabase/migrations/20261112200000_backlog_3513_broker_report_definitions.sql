-- ============================================================================
-- Migration: broker-portal shared report definitions, sharing, and the report rows function
-- Backlog: BACKLOG-3513 (broker side, PR-2). Plan: pm_comments c737f8a4; SR plan review 78c05c83.
--
-- Tables (RPC-only: RLS on, no policies, no grants to PUBLIC / anon / authenticated, TRUNCATE included):
--   public.broker_report_definitions         one shared report definition in one brokerage organization
--   public.broker_report_definition_grants   who else may open it: a person or an organization role
--     principal_role stores the EXACT organization_members.role: agent, broker, admin, it_admin.
--     The share RPC also takes the target 'admins', which writes both admin and it_admin rows
--     (founder ruling: "All admins" includes IT Admins).
--
-- Private helpers (no EXECUTE for authenticated; called only inside the functions below):
--   _broker_report_member_role(uuid, uuid)  role of an ACTIVE member of a brokerage org, else NULL
--   _broker_report_level(uuid)              the CALLER's level on a definition: owner | editor | viewer | NULL
--   _broker_report_audit(uuid, uuid, text, text, jsonb)   one row in public.billing_change_log
--   _broker_report_person_name(uuid)        display name, else first + last name; never the email
--   _broker_report_definitions_immutable()  trigger function
--
-- Callable by authenticated:
--   broker_report_scope(uuid, uuid)                     level / effective row scope / service_off
--   broker_report_submissions_rows(...)                 SECURITY INVOKER: rows under the caller's RLS
--   broker_report_def_list / _get / _create / _update / _delete
--   broker_report_share_list / _share_candidates / _share_set / _share_remove
--   broker_report_set_general_access / broker_report_transfer / broker_report_take_over
--
-- Rules: every SECURITY DEFINER function reads auth.uid() first and raises 42501 when it is NULL;
-- every refusal raises 'Report not found'. Every writer locks the definition row FOR UPDATE first
-- and computes the caller's level after the lock.
--
-- Rows: broker_report_submissions_rows is SECURITY INVOKER, so the transaction_submissions RLS
-- policy is the wall; the effective scope can only narrow. One row per deal head, as the broker
-- Submissions page builds it (broker-portal/lib/submissions/dealList.ts selectDealHeads): a row is
-- superseded only by a child that has landed (status <> 'uploading') inside the same scoped set.
-- Status filter values carry the page's meanings (headMatchesFilter).
--
-- Audit: sharing and lifecycle changes are written to public.billing_change_log (the organization
-- activity log; source 'report'), read by admin_get_org_activity, which this file replaces to add
-- 'report_name' to its detail allow-list (body otherwise unchanged from 20261107160000).
-- billing_change_log is protected by grants only (service_role SELECT / INSERT; no grant to anon or
-- authenticated). It has NO append-only trigger. A rollback of this file leaves its audit rows.
-- A set to an unchanged level writes no audit row.
--
-- Pre-pin: stops unless 20261108190000 and 20261108220000 are recorded, the four scope / feature
-- functions are at their known bodies, and admin_get_org_activity is at its 20261107160000 body
-- or this file's body (second run).
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE, then REVOKE / GRANT.
-- Rollback: supabase/tests/backlog-3513-broker/rollback.sql.
-- ============================================================================

DO $pin$
DECLARE r record;
BEGIN
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations
       WHERE version IN ('20261108190000', '20261108220000')) <> 2 THEN
    RAISE EXCEPTION 'BACKLOG-3513 PR-2: 20261108190000 and 20261108220000 must be applied first';
  END IF;
  FOR r IN
    SELECT v.sig, v.ok, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.org_report_scope(uuid)', ARRAY['5da18d4f3b62daca6e28860897db04c2']),
        ('public.can_review_submission(uuid)', ARRAY['f9af201be08e1509986b2f7e4d98c6bc']),
        ('public.org_billing_service_off(uuid)', ARRAY['09acea5cad4bd6f7eacef272930096d4']),
        ('public._org_feature_allowed(uuid,text)', ARRAY['fc1007396cdff5e197012dd542888a6a']),
        ('public.admin_get_org_activity(uuid,integer)', ARRAY['93ee729f73f23ecd90ffe49ca6d60704', '64c382f43ff03d1f481bdacac67bb64e'])
      ) AS v(sig, ok)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL OR NOT (r.cur = ANY (r.ok)) THEN
      RAISE EXCEPTION 'BACKLOG-3513 PR-2: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'billing_change_log' AND column_name IN ('source', 'txid')) <> 2 THEN
    RAISE EXCEPTION 'BACKLOG-3513 PR-2: billing_change_log has no source/txid columns';
  END IF;
END
$pin$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.broker_report_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dataset_key text NOT NULL CHECK (dataset_key IN ('submissions')),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 16384),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  general_access text NOT NULL DEFAULT 'restricted' CHECK (general_access IN ('restricted', 'organization')),
  row_scope text NOT NULL DEFAULT 'all' CHECK (row_scope IN ('all', 'own')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS broker_report_definitions_org_idx
  ON public.broker_report_definitions (organization_id);

CREATE TABLE IF NOT EXISTS public.broker_report_definition_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL REFERENCES public.broker_report_definitions(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'role')),
  principal_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  principal_role text CHECK (principal_role IN ('agent', 'broker', 'admin', 'it_admin')),
  level text NOT NULL CHECK (level IN ('viewer', 'editor')),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_report_definition_grants_one_principal CHECK (
    (principal_type = 'user' AND principal_user_id IS NOT NULL AND principal_role IS NULL)
    OR (principal_type = 'role' AND principal_role IS NOT NULL AND principal_user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS broker_report_definition_grants_user_uq
  ON public.broker_report_definition_grants (definition_id, principal_user_id) WHERE principal_type = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS broker_report_definition_grants_role_uq
  ON public.broker_report_definition_grants (definition_id, principal_role) WHERE principal_type = 'role';
CREATE INDEX IF NOT EXISTS broker_report_definition_grants_user_idx
  ON public.broker_report_definition_grants (principal_user_id) WHERE principal_type = 'user';

ALTER TABLE public.broker_report_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_report_definition_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.broker_report_definitions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.broker_report_definition_grants FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.broker_report_definitions IS
  'BACKLOG-3513: shared broker-portal report definitions. RPC-only (broker_report_* functions).';
COMMENT ON TABLE public.broker_report_definition_grants IS
  'BACKLOG-3513: who may open a broker report definition: a person or an exact organization role. RPC-only.';

-- Organization, dataset, creator and creation time never change after insert.
CREATE OR REPLACE FUNCTION public._broker_report_definitions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.dataset_key IS DISTINCT FROM OLD.dataset_key
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS broker_report_definitions_immutable ON public.broker_report_definitions;
CREATE TRIGGER broker_report_definitions_immutable
  BEFORE UPDATE ON public.broker_report_definitions
  FOR EACH ROW EXECUTE FUNCTION public._broker_report_definitions_immutable();

-- ---------------------------------------------------------------------------
-- F1: role of an ACTIVE member of a brokerage (non-personal) organization, else NULL.
-- Used for grantee, new-owner and take-over checks. Never calls org_report_scope.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._broker_report_member_role(p_org uuid, p_user uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT m.role::text
            FROM public.organization_members m
            JOIN public.organizations o ON o.id = m.organization_id
           WHERE m.organization_id = p_org
             AND m.user_id = p_user
             AND m.license_status = 'active'
             AND o.personal_owner_user_id IS NULL
           LIMIT 1);
END
$function$;

-- ---------------------------------------------------------------------------
-- F2: the CALLER's level on a definition. NULL unless the caller is an active member of the
-- definition's organization and broker_reports is on there. Owner, else the highest (by integer
-- rank) of: the caller's user grant, the role grant matching the caller's EXACT stored role, and
-- viewer when general access is 'organization'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._broker_report_level(p_def uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_def public.broker_report_definitions%ROWTYPE;
  v_role text;
  v_rank int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_def FROM public.broker_report_definitions WHERE id = p_def;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF public.org_report_scope(v_def.organization_id) IS NULL
     OR NOT coalesce(public._org_feature_allowed(v_def.organization_id, 'broker_reports'), false) THEN
    RETURN NULL;
  END IF;
  IF v_def.owner_user_id = v_uid THEN
    RETURN 'owner';
  END IF;
  v_role := public._broker_report_member_role(v_def.organization_id, v_uid);
  SELECT max(x.r) INTO v_rank FROM (
    SELECT CASE g.level WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 END AS r
      FROM public.broker_report_definition_grants g
     WHERE g.definition_id = p_def
       AND ((g.principal_type = 'user' AND g.principal_user_id = v_uid)
            OR (g.principal_type = 'role' AND g.principal_role = v_role))
    UNION ALL
    SELECT 1 WHERE v_def.general_access = 'organization'
  ) x;
  RETURN CASE v_rank WHEN 2 THEN 'editor' WHEN 1 THEN 'viewer' END;
END
$function$;

-- ---------------------------------------------------------------------------
-- F3: one organization activity row for a report change (actor = the caller).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._broker_report_audit(p_org uuid, p_def uuid, p_name text, p_action text, p_detail jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
  VALUES (p_org, v_uid,
          CASE WHEN p_action IN ('report_created', 'report_deleted', 'report_shared', 'report_share_changed',
                                 'report_unshared', 'report_general_access_changed', 'report_row_scope_changed',
                                 'report_owner_changed') THEN p_action END,
          jsonb_build_object('definition_id', p_def, 'report_name', p_name) || coalesce(p_detail, '{}'::jsonb),
          'report');
END
$function$;

-- ---------------------------------------------------------------------------
-- F4: a person's name for sharing lists: display name, else first + last name. Never the email.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._broker_report_person_name(p_user uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT coalesce(nullif(btrim(u.display_name), ''),
                          nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''))
            FROM public.users u WHERE u.id = p_user);
END
$function$;

-- ---------------------------------------------------------------------------
-- F5: the caller's scope for a report in p_org: the code report (p_def NULL) or one definition.
-- Refuses before anything else for a non-member, broker_reports off, an unknown definition, a
-- definition in another organization, or (base 'all') broker_portal_access off.
-- effective_scope 'own' when the caller's base scope is 'own', when a VIEWER opens a definition
-- whose row_scope is 'own', or when the brokerage's service is off (the predicate RLS uses).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_scope(p_org uuid, p_def uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_base text;
  v_level text;
  v_row_scope text;
  v_def_org uuid;
  v_off boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_base := public.org_report_scope(p_org);
  IF p_org IS NULL OR v_base IS NULL
     OR NOT coalesce(public._org_feature_allowed(p_org, 'broker_reports'), false) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  IF v_base = 'all' AND NOT coalesce(public._org_feature_allowed(p_org, 'broker_portal_access'), false) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  IF p_def IS NOT NULL THEN
    SELECT d.organization_id, d.row_scope INTO v_def_org, v_row_scope
      FROM public.broker_report_definitions d WHERE d.id = p_def;
    IF v_def_org IS DISTINCT FROM p_org THEN
      RAISE EXCEPTION 'Report not found';
    END IF;
    v_level := public._broker_report_level(p_def);
    IF v_level IS NULL THEN
      RAISE EXCEPTION 'Report not found';
    END IF;
  END IF;
  v_off := coalesce(public.org_billing_service_off(p_org), false);
  RETURN jsonb_build_object(
    'level', v_level,
    'row_scope', v_row_scope,
    'service_off', v_off,
    'effective_scope', CASE
      WHEN v_base = 'own' THEN 'own'
      WHEN v_level = 'viewer' AND v_row_scope = 'own' THEN 'own'
      WHEN v_off THEN 'own'
      ELSE 'all' END);
END
$function$;

-- ---------------------------------------------------------------------------
-- F6: the Submissions report rows. SECURITY INVOKER: transaction_submissions RLS applies.
-- p_status is one list filter value: NULL / 'all', 'new' (submitted), 'submitted'
-- (submitted + resubmitted), 'pending' (+ under_review), or one exact status.
-- p_sort: newest (default), oldest, status, price_desc, price_asc. p_limit clamped to 1-200.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_submissions_rows(
  p_org uuid,
  p_def uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_agent uuid DEFAULT NULL,
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
BEGIN
  v_eff := public.broker_report_scope(p_org, p_def) ->> 'effective_scope';
  v_statuses := CASE
    WHEN p_status IS NULL OR p_status = 'all' THEN NULL
    WHEN p_status = 'new' THEN ARRAY['submitted']
    WHEN p_status = 'submitted' THEN ARRAY['submitted', 'resubmitted']
    WHEN p_status = 'pending' THEN ARRAY['submitted', 'resubmitted', 'under_review']
    ELSE ARRAY[p_status] END;
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
     AND (p_agent IS NULL OR s.submitted_by = p_agent)
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

-- ---------------------------------------------------------------------------
-- F7: definitions in p_org the caller may open.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_def_list(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_org IS NULL OR public.org_report_scope(p_org) IS NULL
     OR NOT coalesce(public._org_feature_allowed(p_org, 'broker_reports'), false) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id, 'name', x.name, 'dataset_key', x.dataset_key, 'level', x.lvl,
             'owner_name', public._broker_report_person_name(x.owner_user_id),
             'updated_at', x.updated_at) ORDER BY x.name, x.id), '[]'::jsonb)
      FROM (SELECT d.*, public._broker_report_level(d.id) AS lvl
              FROM public.broker_report_definitions d WHERE d.organization_id = p_org) x
     WHERE x.lvl IS NOT NULL);
END
$function$;

-- ---------------------------------------------------------------------------
-- F8: one definition, for anyone with a level on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_def_get(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_level text;
  d public.broker_report_definitions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_level := public._broker_report_level(p_def);
  IF v_level IS NULL THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def;
  RETURN jsonb_build_object(
    'id', d.id, 'organization_id', d.organization_id, 'dataset_key', d.dataset_key,
    'name', d.name, 'description', d.description, 'definition', d.definition,
    'row_scope', d.row_scope, 'general_access', d.general_access, 'level', v_level,
    'owner', jsonb_build_object('name', public._broker_report_person_name(d.owner_user_id),
                                'is_you', d.owner_user_id IS NOT DISTINCT FROM v_uid),
    'updated_at', d.updated_at);
END
$function$;

-- ---------------------------------------------------------------------------
-- F9: create. Any active member of the organization (agents included) when broker_reports is on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_def_create(
  p_org uuid, p_dataset text, p_name text, p_description text, p_definition jsonb, p_row_scope text DEFAULT 'all')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_org IS NULL OR public.org_report_scope(p_org) IS NULL
     OR NOT coalesce(public._org_feature_allowed(p_org, 'broker_reports'), false) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  INSERT INTO public.broker_report_definitions
    (organization_id, dataset_key, name, description, definition, owner_user_id, row_scope, created_by, updated_by)
  VALUES (p_org, p_dataset, v_name, nullif(btrim(coalesce(p_description, '')), ''),
          coalesce(p_definition, '{}'::jsonb), v_uid, coalesce(p_row_scope, 'all'), v_uid, v_uid)
  RETURNING id INTO v_id;
  PERFORM public._broker_report_audit(p_org, v_id, v_name, 'report_created', '{}'::jsonb);
  RETURN v_id;
END
$function$;

-- ---------------------------------------------------------------------------
-- F10: update. Owner or editor (row_scope included: founder ruling 2026-11-12, editors may change
-- it); refused on a stale p_expected_updated_at. p_row_scope NULL keeps it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_def_update(
  p_def uuid, p_name text, p_description text, p_definition jsonb, p_row_scope text, p_expected_updated_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_level text;
  v_scope text;
  v_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  v_level := public._broker_report_level(p_def);
  IF d.id IS NULL OR v_level IS NULL OR v_level NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  v_scope := coalesce(p_row_scope, d.row_scope);
  IF p_expected_updated_at IS DISTINCT FROM d.updated_at THEN
    RAISE EXCEPTION 'Report changed' USING ERRCODE = '40001';
  END IF;
  UPDATE public.broker_report_definitions
     SET name = btrim(coalesce(p_name, '')),
         description = nullif(btrim(coalesce(p_description, '')), ''),
         definition = coalesce(p_definition, '{}'::jsonb),
         row_scope = v_scope,
         updated_by = v_uid,
         updated_at = clock_timestamp()
   WHERE id = p_def
  RETURNING updated_at INTO v_at;
  IF v_scope IS DISTINCT FROM d.row_scope THEN
    PERFORM public._broker_report_audit(d.organization_id, p_def, btrim(coalesce(p_name, '')),
      'report_row_scope_changed', jsonb_build_object('from', d.row_scope, 'to', v_scope));
  END IF;
  RETURN jsonb_build_object('updated_at', v_at);
END
$function$;

-- ---------------------------------------------------------------------------
-- F11: delete. Owner only. Removes every saved view on the definition's 'd-<id>' key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_def_delete(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  IF d.id IS NULL OR public._broker_report_level(p_def) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  DELETE FROM public.broker_report_saved_views
   WHERE organization_id = d.organization_id AND report_key = lower('d-' || p_def::text);
  DELETE FROM public.broker_report_definitions WHERE id = p_def;
  PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_deleted', '{}'::jsonb);
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- F12: who has access. Owner or editor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_share_list(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_level text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_level := public._broker_report_level(p_def);
  IF v_level IS NULL OR v_level NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def;
  RETURN jsonb_build_object(
    'owner', jsonb_build_object(
      'id', d.owner_user_id,
      'name', public._broker_report_person_name(d.owner_user_id),
      'role', public._broker_report_member_role(d.organization_id, d.owner_user_id),
      'is_you', d.owner_user_id IS NOT DISTINCT FROM v_uid),
    'general_access', d.general_access,
    'row_scope', d.row_scope,
    'level', v_level,
    'entries', (
      SELECT coalesce(jsonb_agg(e ORDER BY e ->> 'kind' DESC, e ->> 'name', e ->> 'id'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('kind', 'person', 'id', g.principal_user_id,
                 'name', public._broker_report_person_name(g.principal_user_id),
                 'detail', public._broker_report_member_role(d.organization_id, g.principal_user_id),
                 'level', g.level) AS e
          FROM public.broker_report_definition_grants g
         WHERE g.definition_id = p_def AND g.principal_type = 'user'
        UNION ALL
        -- admin + it_admin at the same level read back as the one 'admins' target ("All admins")
        SELECT DISTINCT jsonb_build_object('kind', 'role', 'id', y.rid,
                 'name', CASE y.rid WHEN 'agent' THEN 'All agents' WHEN 'broker' THEN 'All brokers'
                                    WHEN 'admins' THEN 'All admins' WHEN 'admin' THEN 'Admins only'
                                    ELSE 'IT admins only' END,
                 'detail', NULL, 'level', y.level)
          FROM (SELECT CASE WHEN g.principal_role IN ('admin', 'it_admin')
                             AND (SELECT count(*) FROM public.broker_report_definition_grants g2
                                   WHERE g2.definition_id = p_def AND g2.principal_type = 'role'
                                     AND g2.principal_role IN ('admin', 'it_admin') AND g2.level = g.level) = 2
                            THEN 'admins' ELSE g.principal_role END AS rid,
                       g.level
                  FROM public.broker_report_definition_grants g
                 WHERE g.definition_id = p_def AND g.principal_type = 'role') y
      ) x(e)));
END
$function$;

-- ---------------------------------------------------------------------------
-- F13: who the caller may add. Owner or editor of THAT definition. Active members of the
-- definition's organization (never an email), and three role targets: All agents, All brokers,
-- All admins ('admins' = admin AND it_admin).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_share_candidates(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_level text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_level := public._broker_report_level(p_def);
  IF v_level IS NULL OR v_level NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  SELECT organization_id INTO v_org FROM public.broker_report_definitions WHERE id = p_def;
  RETURN jsonb_build_object(
    'people', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'kind', 'person', 'id', m.user_id,
               'name', coalesce(public._broker_report_person_name(m.user_id), 'Member'),
               'detail', CASE m.role WHEN 'agent' THEN 'Agent' WHEN 'broker' THEN 'Broker'
                                     WHEN 'admin' THEN 'Admin' WHEN 'it_admin' THEN 'IT Admin' END)
               ORDER BY public._broker_report_person_name(m.user_id), m.user_id), '[]'::jsonb)
        FROM public.organization_members m
        JOIN public.organizations o ON o.id = m.organization_id
       WHERE m.organization_id = v_org
         AND m.license_status = 'active'
         AND m.user_id IS NOT NULL
         AND o.personal_owner_user_id IS NULL),
    'roles', (
      SELECT jsonb_agg(jsonb_build_object('kind', 'role', 'id', t.id, 'name', t.name,
               'detail', (SELECT count(*) FROM public.organization_members m
                           WHERE m.organization_id = v_org AND m.license_status = 'active'
                             AND m.user_id IS NOT NULL AND m.role = ANY (t.roles))::text || ' people')
               ORDER BY t.ord)
        FROM (VALUES (1, 'agent', 'All agents', ARRAY['agent']),
                     (2, 'broker', 'All brokers', ARRAY['broker']),
                     (3, 'admins', 'All admins', ARRAY['admin', 'it_admin'])) AS t(ord, id, name, roles)));
END
$function$;

-- ---------------------------------------------------------------------------
-- F14: grant one level to several principals in one call. Owner or editor; editors may grant
-- Can edit. p_principals: [{"kind": "person" | "role", "id": ...}], 1-50 entries. Role ids:
-- agent, broker, admin, it_admin, or admins (writes admin AND it_admin). The whole call is
-- refused for any invalid principal: the owner, a person who is not an active member of the
-- definition's organization, an unknown role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_share_set(p_def uuid, p_principals jsonb, p_level text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_level text;
  p jsonb;
  v_user uuid;
  v_role text;
  v_old text;
  v_member uuid;
  v_users uuid[] := '{}';
  v_roles text[] := '{}';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  v_level := public._broker_report_level(p_def);
  IF d.id IS NULL OR v_level IS NULL OR v_level NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  IF p_level IS NULL OR p_level NOT IN ('viewer', 'editor')
     OR jsonb_typeof(p_principals) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_principals) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  -- validate everything before writing anything
  FOR p IN SELECT * FROM jsonb_array_elements(p_principals) LOOP
    IF p ->> 'kind' = 'person' AND (p ->> 'id') ~ '^[0-9a-fA-F-]{36}$' THEN
      v_user := (p ->> 'id')::uuid;
      IF v_user IS NOT DISTINCT FROM d.owner_user_id
         OR public._broker_report_member_role(d.organization_id, v_user) IS NULL THEN
        RAISE EXCEPTION 'Report not found';
      END IF;
      v_users := v_users || v_user;
    ELSIF p ->> 'kind' = 'role' AND p ->> 'id' IN ('agent', 'broker', 'admin', 'it_admin') THEN
      v_roles := v_roles || (p ->> 'id');
    ELSIF p ->> 'kind' = 'role' AND p ->> 'id' = 'admins' THEN
      v_roles := v_roles || ARRAY['admin', 'it_admin'];
    ELSE
      RAISE EXCEPTION 'Report not found';
    END IF;
  END LOOP;

  FOR v_user IN SELECT DISTINCT u FROM unnest(v_users) u LOOP
    SELECT g.level INTO v_old FROM public.broker_report_definition_grants g
     WHERE g.definition_id = p_def AND g.principal_type = 'user' AND g.principal_user_id = v_user;
    IF v_old IS NULL THEN
      INSERT INTO public.broker_report_definition_grants (definition_id, principal_type, principal_user_id, level, granted_by)
      VALUES (p_def, 'user', v_user, p_level, v_uid);
    ELSE
      UPDATE public.broker_report_definition_grants SET level = p_level, granted_by = v_uid, updated_at = now()
       WHERE definition_id = p_def AND principal_type = 'user' AND principal_user_id = v_user;
    END IF;
    IF v_old IS DISTINCT FROM p_level THEN
      SELECT m.id INTO v_member FROM public.organization_members m
       WHERE m.organization_id = d.organization_id AND m.user_id = v_user LIMIT 1;
      PERFORM public._broker_report_audit(d.organization_id, p_def, d.name,
        CASE WHEN v_old IS NULL THEN 'report_shared' ELSE 'report_share_changed' END,
        jsonb_build_object('member_id', v_member, 'from', v_old, 'to', p_level));
    END IF;
  END LOOP;

  FOR v_role IN SELECT DISTINCT r FROM unnest(v_roles) r ORDER BY 1 LOOP
    SELECT g.level INTO v_old FROM public.broker_report_definition_grants g
     WHERE g.definition_id = p_def AND g.principal_type = 'role' AND g.principal_role = v_role;
    IF v_old IS NULL THEN
      INSERT INTO public.broker_report_definition_grants (definition_id, principal_type, principal_role, level, granted_by)
      VALUES (p_def, 'role', v_role, p_level, v_uid);
    ELSE
      UPDATE public.broker_report_definition_grants SET level = p_level, granted_by = v_uid, updated_at = now()
       WHERE definition_id = p_def AND principal_type = 'role' AND principal_role = v_role;
    END IF;
    IF v_old IS DISTINCT FROM p_level THEN
      PERFORM public._broker_report_audit(d.organization_id, p_def, d.name,
        CASE WHEN v_old IS NULL THEN 'report_shared' ELSE 'report_share_changed' END,
        jsonb_build_object('role', v_role, 'from', v_old, 'to', p_level));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- F15: remove one principal. Owner or editor; or anyone removing their own person grant.
-- p_kind 'person' (p_id = user id) or 'role' (agent, broker, admin, it_admin, or admins = both).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_share_remove(p_def uuid, p_kind text, p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_level text;
  v_user uuid;
  v_roles text[];
  r record;
  v_member uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  v_level := public._broker_report_level(p_def);
  IF d.id IS NULL OR v_level IS NULL THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  IF p_kind = 'person' AND p_id ~ '^[0-9a-fA-F-]{36}$' THEN
    v_user := p_id::uuid;
    IF v_level NOT IN ('owner', 'editor') AND v_user IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'Report not found';
    END IF;
    FOR r IN DELETE FROM public.broker_report_definition_grants g
              WHERE g.definition_id = p_def AND g.principal_type = 'user' AND g.principal_user_id = v_user
          RETURNING g.level LOOP
      SELECT m.id INTO v_member FROM public.organization_members m
       WHERE m.organization_id = d.organization_id AND m.user_id = v_user LIMIT 1;
      PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_unshared',
        jsonb_build_object('member_id', v_member, 'from', r.level, 'to', NULL));
    END LOOP;
  ELSIF p_kind = 'role' AND p_id IN ('agent', 'broker', 'admin', 'it_admin', 'admins') THEN
    IF v_level NOT IN ('owner', 'editor') THEN
      RAISE EXCEPTION 'Report not found';
    END IF;
    v_roles := CASE WHEN p_id = 'admins' THEN ARRAY['admin', 'it_admin'] ELSE ARRAY[p_id] END;
    FOR r IN DELETE FROM public.broker_report_definition_grants g
              WHERE g.definition_id = p_def AND g.principal_type = 'role' AND g.principal_role = ANY (v_roles)
          RETURNING g.principal_role, g.level LOOP
      PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_unshared',
        jsonb_build_object('role', r.principal_role, 'from', r.level, 'to', NULL));
    END LOOP;
  ELSE
    RAISE EXCEPTION 'Report not found';
  END IF;
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- F16: general access ('restricted' | 'organization'). Owner or editor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_set_general_access(p_def uuid, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_level text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  v_level := public._broker_report_level(p_def);
  IF d.id IS NULL OR v_level IS NULL OR v_level NOT IN ('owner', 'editor')
     OR p_value IS NULL OR p_value NOT IN ('restricted', 'organization') THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  IF p_value IS DISTINCT FROM d.general_access THEN
    UPDATE public.broker_report_definitions SET general_access = p_value WHERE id = p_def;
    PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_general_access_changed',
      jsonb_build_object('from', d.general_access, 'to', p_value));
  END IF;
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- F17: transfer ownership. OWNER only. The new owner: any active member of the definition's
-- organization other than the caller. The new owner's person grant is removed and the old owner
-- keeps Can edit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_transfer(p_def uuid, p_new_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_member uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  IF d.id IS NULL OR public._broker_report_level(p_def) IS DISTINCT FROM 'owner'
     OR p_new_owner IS NULL OR p_new_owner = v_uid
     OR public._broker_report_member_role(d.organization_id, p_new_owner) IS NULL THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  UPDATE public.broker_report_definitions SET owner_user_id = p_new_owner WHERE id = p_def;
  DELETE FROM public.broker_report_definition_grants
   WHERE definition_id = p_def AND principal_type = 'user' AND principal_user_id = p_new_owner;
  INSERT INTO public.broker_report_definition_grants (definition_id, principal_type, principal_user_id, level, granted_by)
  VALUES (p_def, 'user', v_uid, 'editor', v_uid)
  ON CONFLICT (definition_id, principal_user_id) WHERE principal_type = 'user'
  DO UPDATE SET level = 'editor', granted_by = EXCLUDED.granted_by, updated_at = now();
  SELECT m.id INTO v_member FROM public.organization_members m
   WHERE m.organization_id = d.organization_id AND m.user_id = p_new_owner LIMIT 1;
  PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_owner_changed',
    jsonb_build_object('member_id', v_member));
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- F18: take over a report whose owner is gone (owner NULL or no longer an active member).
-- Caller: an active broker or admin of the definition's organization, broker_reports on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_take_over(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_member uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  IF NOT FOUND
     OR coalesce(public._broker_report_member_role(d.organization_id, v_uid), '') NOT IN ('broker', 'admin')
     OR NOT coalesce(public._org_feature_allowed(d.organization_id, 'broker_reports'), false)
     OR (d.owner_user_id IS NOT NULL
         AND public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NOT NULL) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  UPDATE public.broker_report_definitions SET owner_user_id = v_uid WHERE id = p_def;
  DELETE FROM public.broker_report_definition_grants
   WHERE definition_id = p_def AND principal_type = 'user' AND principal_user_id = v_uid;
  SELECT m.id INTO v_member FROM public.organization_members m
   WHERE m.organization_id = d.organization_id AND m.user_id = v_uid LIMIT 1;
  PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_owner_changed',
    jsonb_build_object('member_id', v_member, 'via', 'take_over'));
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- The organization activity reader: 'report_name' joins the detail allow-list. Otherwise the
-- 20261107160000 body, unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_org_activity(p_org uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_billing boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission(v_uid, 'organizations.view') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  v_billing := public.has_permission(v_uid, 'billing.view');

  WITH org_rows AS (
    SELECT c.created_at, c.action, c.actor_id, c.detail
      FROM public.billing_change_log c
     WHERE c.organization_id = p_org
       AND (v_billing OR c.action NOT IN ('deal_saved', 'seats_changed', 'suspended', 'reinstated',
                                          'auto_renew_on', 'auto_renew_off', 'deal_ended', 'setup_completed'))
       -- a trigger row is hidden when an explicit row of the same transaction names the member
       AND NOT (c.source IS NOT DISTINCT FROM 'trigger' AND EXISTS (
             SELECT 1 FROM public.billing_change_log e
              WHERE e.organization_id = c.organization_id
                AND e.txid = c.txid
                AND e.source IS DISTINCT FROM 'trigger'
                AND c.detail ->> 'member_id' IN (e.detail ->> 'member_id', e.detail ->> 'old_member_id')))
  ),
  staff_rows AS (
    SELECT a.created_at, a.action, a.actor_id,
           jsonb_strip_nulls(jsonb_build_object('plan', pl.name)) AS detail
      FROM public.admin_audit_logs a
      LEFT JOIN public.plans pl ON a.action = 'org_plan.assigned' AND pl.id::text = a.metadata ->> 'plan_id'
     WHERE a.target_type = 'organization'
       AND coalesce(a.metadata ->> 'organization_id', a.target_id) = p_org::text
       AND a.action IN ('organization.created', 'org_plan.assigned')
  ),
  merged AS (
    SELECT * FROM org_rows
    UNION ALL
    SELECT * FROM staff_rows
    ORDER BY 1 DESC
    LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'created_at', x.created_at,
           'action', x.action,
           'actor_name', coalesce(nullif(btrim(au.display_name), ''), au.email,
                                  CASE WHEN x.actor_id IS NOT NULL THEN NULL
                                       WHEN x.detail ->> 'via' = 'directory' THEN 'Directory sync'
                                       ELSE 'Keepr' END),
           'actor_is_staff', x.actor_id IS NOT NULL
                             AND EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = x.actor_id),
           'actor_is_subject', coalesce(x.actor_id = sm.user_id, false),
           'subject_name', coalesce(public._member_person(sm.id) ->> 'name', x.detail ->> 'name', x.detail ->> 'email'),
           'detail', (SELECT coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb)
                        FROM jsonb_each(x.detail) k
                       WHERE k.key IN ('from', 'to', 'role', 'via', 'cleared', 'seats', 'reason', 'note', 'ends_on', 'plan', 'notified', 'report_name')))
           ORDER BY x.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM merged x
    LEFT JOIN public.users au ON au.id = x.actor_id
    LEFT JOIN public.organization_members sm
      ON sm.organization_id = p_org
     AND sm.id::text = x.detail ->> 'member_id';
  RETURN v_out;
END
$function$;

REVOKE ALL ON FUNCTION public.admin_get_org_activity(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_org_activity(uuid, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grants. Private: no EXECUTE for PUBLIC, anon or authenticated.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._broker_report_definitions_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._broker_report_member_role(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._broker_report_level(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._broker_report_audit(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._broker_report_person_name(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.broker_report_scope(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_submissions_rows(uuid, uuid, text, uuid, timestamptz, timestamptz, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_def_list(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_def_get(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_def_create(uuid, text, text, text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_def_update(uuid, text, text, jsonb, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_def_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_share_list(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_share_candidates(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_share_set(uuid, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_share_remove(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_set_general_access(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_transfer(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_take_over(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.broker_report_scope(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_submissions_rows(uuid, uuid, text, uuid, timestamptz, timestamptz, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_def_list(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_def_get(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_def_create(uuid, text, text, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_def_update(uuid, text, text, jsonb, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_def_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_share_list(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_share_candidates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_share_set(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_share_remove(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_set_general_access(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_transfer(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_take_over(uuid) TO authenticated;
