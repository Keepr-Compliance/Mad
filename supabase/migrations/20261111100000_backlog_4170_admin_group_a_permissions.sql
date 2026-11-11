-- BACKLOG-4170 PR1 — six admin-portal functions read per permission
--
-- Each function below admitted any caller holding an internal role. Each now also requires the
-- permission the admin-portal page that calls it already requires. The internal-role check is kept
-- and the permission is ANDed to it (a caller must pass both). Each refusal is unchanged (the same
-- RAISE text and SQLSTATE, or admin_list_organizations' {success:false,error:'not_authorized'}), so
-- no caller changes. Only the guard changes; every other line of each body is the production text.
--
--   admin_search_users(text, integer)         users.view
--   admin_get_user_detail(uuid)               users.view
--   admin_list_organizations()                organizations.view
--   admin_get_audit_logs(6 args)              audit.view, or plans.view when p_action is exactly
--                                             'billing.solo_trial_updated' (the Plans page's
--                                             last-trial-change line; NULL-safe: a NULL p_action
--                                             does not take the plans.view branch)
--   admin_get_brokerage_billing_live()        organizations.view, organizations.edit or billing.view
--   admin_get_solo_trial_setting()            plans.view or billing.pricebook
--
-- Helpers are caller-bound (check_user_id = auth.uid()) SECURITY DEFINER EXISTS queries and never
-- return NULL. Functions with search_path '' call them schema-qualified.
--
-- Grants: EXECUTE revoked from PUBLIC and anon on all six (three held it), granted to authenticated
-- and service_role (both held today). No function here is meant to be callable signed out.
--
-- Pre-pin: the migration stops unless each body is the production text or this file's text.
-- Rollback: supabase/tests/backlog-4170-p1/rollback-4170-p1.sql (production text and ACL).

DO $pin$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v.sig, v.prod, v.post, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.admin_search_users(text,integer)', '3b2bf87eaad57515208cc5cb9e7747ee', '2ded913e46f67ac65c4208976f3ac240'),
        ('public.admin_get_user_detail(uuid)', 'e690d13b157f1ec88cd664f59cfacde4', 'fe2ed884c110aac7ad0e7075d093cc6c'),
        ('public.admin_list_organizations()', 'cb0100fd0402877d93f02599b18a7a69', '38097f0da44a2cbb344f29e57e0b49f1'),
        ('public.admin_get_audit_logs(integer,integer,text,text,timestamptz,timestamptz)', 'eaf915a01751b05e0da618dbed3a5cd5', '90abae5cd041ce79c185176f0f5f1dfa'),
        ('public.admin_get_brokerage_billing_live()', '90a6fabf60de43968c1c3aa84dd083c9', 'e452dd90c43b2265d5511519cc13f3d8'),
        ('public.admin_get_solo_trial_setting()', '833a9f7049885faeccdb36a0f03ad543', '321f89f7fdd6a113a5006bc6d1395ce7')
      ) AS v(sig, prod, post)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR1: % not found', r.sig;
    END IF;
    IF r.cur NOT IN (r.prod, r.post) THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR1: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- users.view
CREATE OR REPLACE FUNCTION public.admin_search_users(search_query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, email text, first_name text, last_name text, display_name text, avatar_url text, status text, is_active boolean, subscription_tier text, last_login_at timestamp with time zone, org_name text, org_slug text, org_role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Validate caller has internal role and users.view (BACKLOG-4170)
  IF NOT has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'users.view') THEN
    RAISE EXCEPTION 'Unauthorized: internal role required';
  END IF;

  -- Cap result limit at 100
  IF result_limit > 100 THEN
    result_limit := 100;
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::TEXT,
    u.first_name::TEXT,
    u.last_name::TEXT,
    u.display_name::TEXT,
    u.avatar_url::TEXT,
    u.status::TEXT,
    u.is_active,
    u.subscription_tier::TEXT,
    u.last_login_at,
    string_agg(DISTINCT o.name::TEXT, ', ' ORDER BY o.name::TEXT)  AS org_name,
    string_agg(DISTINCT o.slug::TEXT, ', ' ORDER BY o.slug::TEXT)  AS org_slug,
    string_agg(DISTINCT om.role::TEXT, ', ' ORDER BY om.role::TEXT) AS org_role
  FROM users u
  LEFT JOIN organization_members om ON om.user_id = u.id
  LEFT JOIN organizations o ON o.id = om.organization_id
  WHERE
    search_query = ''
    OR u.email ILIKE '%' || search_query || '%'
    OR u.first_name ILIKE '%' || search_query || '%'
    OR u.last_name ILIKE '%' || search_query || '%'
    OR u.display_name ILIKE '%' || search_query || '%'
    OR o.slug ILIKE '%' || search_query || '%'
    OR o.name ILIKE '%' || search_query || '%'
    OR (length(search_query) = 36 AND u.id::TEXT = search_query)
  GROUP BY u.id, u.email, u.first_name, u.last_name, u.display_name,
           u.avatar_url, u.status, u.is_active, u.subscription_tier, u.last_login_at
  ORDER BY u.last_login_at DESC NULLS LAST
  LIMIT result_limit;
END;
$function$;

-- users.view
CREATE OR REPLACE FUNCTION public.admin_get_user_detail(target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result JSONB;
BEGIN
  -- Validate caller has internal role and users.view (BACKLOG-4170)
  IF NOT has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'users.view') THEN
    RAISE EXCEPTION 'Unauthorized: internal role required';
  END IF;

  SELECT jsonb_build_object(
    'user', (SELECT jsonb_build_object(
      'id', u.id,
      'email', u.email,
      'first_name', u.first_name,
      'last_name', u.last_name,
      'display_name', u.display_name,
      'avatar_url', u.avatar_url,
      'status', u.status,
      'is_active', u.is_active,
      'subscription_tier', u.subscription_tier,
      'subscription_status', u.subscription_status,
      'last_login_at', u.last_login_at,
      'login_count', u.login_count,
      'created_at', u.created_at,
      'trial_ends_at', u.trial_ends_at,
      'suspended_at', u.suspended_at,
      'suspension_reason', u.suspension_reason,
      'onboarding_completed_at', u.onboarding_completed_at,
      'oauth_provider', u.oauth_provider
    ) FROM users u WHERE u.id = target_user_id),
    'organizations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'org_id', o.id,
        'org_name', o.name,
        'org_slug', o.slug,
        'role', om.role,
        'license_status', om.license_status,
        'joined_at', om.created_at
      ))
      FROM organization_members om
      JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = target_user_id
    ), '[]'::jsonb),
    'license', (SELECT jsonb_build_object(
      'id', l.id,
      'status', l.status,
      'license_type', l.license_type,
      'max_devices', l.max_devices,
      'trial_status', l.trial_status,
      'trial_started_at', l.trial_started_at,
      'trial_expires_at', l.trial_expires_at,
      'transaction_count', l.transaction_count,
      'transaction_limit', l.transaction_limit,
      'activated_at', l.activated_at,
      'expires_at', l.expires_at,
      'created_at', l.created_at
    ) FROM licenses l WHERE l.user_id = target_user_id LIMIT 1),
    'devices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id,
        'device_id', d.device_id,
        'device_name', d.device_name,
        'os', d.os,
        'platform', d.platform,
        'app_version', d.app_version,
        'is_active', d.is_active,
        'last_seen_at', d.last_seen_at,
        'created_at', d.created_at
      ) ORDER BY d.last_seen_at DESC NULLS LAST)
      FROM devices d WHERE d.user_id = target_user_id
    ), '[]'::jsonb),
    'recent_audit_logs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', al.id,
        'action', al.action,
        'resource_type', al.resource_type,
        'resource_id', al.resource_id,
        'metadata', al.metadata,
        'success', al.success,
        'timestamp', al."timestamp"
      ) ORDER BY al."timestamp" DESC)
      FROM (
        SELECT * FROM audit_logs
        WHERE user_id = target_user_id
        ORDER BY "timestamp" DESC
        LIMIT 50
      ) al
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$function$;

-- organizations.view
CREATE OR REPLACE FUNCTION public.admin_list_organizations()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'organizations.view') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  RETURN jsonb_build_object('success', true, 'organizations', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', o.id,
      'name', o.name,
      'slug', o.slug,
      'max_seats', o.max_seats,
      'created_at', o.created_at,
      'plan_name', p.name,
      'plan_tier', p.tier,
      'member_count', (SELECT count(*) FROM organization_members om WHERE om.organization_id = o.id),
      'is_personal', (o.personal_owner_user_id IS NOT NULL),
      'is_test', o.is_test
    ) ORDER BY o.name)
    FROM organizations o
    LEFT JOIN organization_plans op ON op.organization_id = o.id
    LEFT JOIN plans p ON p.id = op.plan_id
  ));
END;
$function$;

-- audit.view, or plans.view for the 'billing.solo_trial_updated' action only (NULL-safe)
CREATE OR REPLACE FUNCTION public.admin_get_audit_logs(p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_action text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_logs jsonb;
  v_total bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.internal_roles WHERE user_id = auth.uid()
  ) OR NOT (
    public.has_permission(auth.uid(), 'audit.view')
    OR (p_action IS NOT DISTINCT FROM 'billing.solo_trial_updated'
        AND public.has_permission(auth.uid(), 'plans.view'))
  ) THEN
    RAISE EXCEPTION 'Unauthorized: internal role required';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.admin_audit_logs a
  WHERE (p_action IS NULL OR a.action = p_action)
    AND (p_target_id IS NULL OR a.target_id ILIKE '%' || p_target_id || '%')
    AND (p_date_from IS NULL OR a.created_at >= p_date_from)
    AND (p_date_to IS NULL OR a.created_at <= p_date_to);

  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO v_logs
  FROM (
    SELECT
      a.id, a.action, a.target_type, a.target_id, a.metadata,
      a.ip_address::text, a.user_agent, a.created_at, a.actor_id,
      u.email as actor_email,
      u.raw_user_meta_data->>'full_name' as actor_name,
      tu.email as target_email,
      tu.raw_user_meta_data->>'full_name' as target_name
    FROM public.admin_audit_logs a
    LEFT JOIN auth.users u ON u.id = a.actor_id
    LEFT JOIN auth.users tu ON a.target_type = 'user' AND tu.id = a.target_id::uuid
    WHERE (p_action IS NULL OR a.action = p_action)
      AND (p_target_id IS NULL OR a.target_id ILIKE '%' || p_target_id || '%')
      AND (p_date_from IS NULL OR a.created_at >= p_date_from)
      AND (p_date_to IS NULL OR a.created_at <= p_date_to)
    ORDER BY a.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;

  RETURN jsonb_build_object('logs', v_logs, 'total', v_total);
END;
$function$;

-- organizations.view, organizations.edit or billing.view
CREATE OR REPLACE FUNCTION public.admin_get_brokerage_billing_live()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(public.has_internal_role(v_uid), false)
     OR NOT coalesce(public.has_any_permission(v_uid, ARRAY['organizations.view', 'organizations.edit', 'billing.view']), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN public._billing_brokerage_live();
END
$function$;

-- plans.view or billing.pricebook
CREATE OR REPLACE FUNCTION public.admin_get_solo_trial_setting()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_enabled boolean;
  v_days integer;
  v_updated_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(public.has_internal_role(v_uid), false)
     OR NOT coalesce(public.has_any_permission(v_uid, ARRAY['plans.view', 'billing.pricebook']), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT s.enabled, s.days, s.updated_at INTO v_enabled, v_days, v_updated_at
    FROM public.billing_settings s
   WHERE s.key = 'solo_trial';
  -- An absent row reads as off.
  RETURN jsonb_build_object(
    'enabled', coalesce(v_enabled, false),
    'days', v_days,
    'updated_at', v_updated_at,
    'can_edit', coalesce(public.has_permission(v_uid, 'billing.pricebook'), false));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_search_users(text, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_organizations() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_audit_logs(integer, integer, text, text, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_brokerage_billing_live() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_solo_trial_setting() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_search_users(text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_organizations() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_audit_logs(integer, integer, text, text, timestamp with time zone, timestamp with time zone) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_brokerage_billing_live() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_solo_trial_setting() TO authenticated, service_role;
