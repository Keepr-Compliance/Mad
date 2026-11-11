-- BACKLOG-3962 PR3a rollback: undoes 20261112113000_backlog_3962_domain_capture.sql.
-- Restores the PR1 bodies of domain_claim_withdraw, admin_revoke_domain_claim and
-- _domain_claim_record_check (copied verbatim from 20261112100000), drops every PR3a function and
-- the table, and puts the provisioned_by CHECK back. Refuses while any member row carries
-- provisioned_by 'domain_capture' (those rows would violate the old CHECK).
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM public.organization_members WHERE provisioned_by = 'domain_capture') THEN
    RAISE EXCEPTION 'BACKLOG-3962 rollback: members with provisioned_by domain_capture exist';
  END IF;
END
$rb$;

CREATE OR REPLACE FUNCTION public.domain_claim_withdraw(p_claim uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.domain_claims;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  SELECT * INTO v_row FROM public.domain_claims c WHERE c.id = p_claim FOR UPDATE;
  -- Not found and not this caller's org read the same, so a claim id leaks nothing.
  IF NOT FOUND OR NOT public.is_org_admin(v_uid, v_row.organization_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_row.status NOT IN ('pending', 'verified', 'lapsed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_withdrawable');
  END IF;
  UPDATE public.domain_claims SET status = 'withdrawn', updated_at = now() WHERE id = v_row.id;
  RETURN jsonb_build_object('success', true, 'claim_id', v_row.id, 'status', 'withdrawn');
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_revoke_domain_claim(p_claim uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.domain_claims;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF NOT public.has_internal_role(v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_internal_user');
  END IF;
  IF NOT public.has_permission(v_uid, 'organizations.edit') THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_permissions');
  END IF;
  IF v_reason = '' OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reason');
  END IF;
  SELECT * INTO v_row FROM public.domain_claims c WHERE c.id = p_claim FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_row.status NOT IN ('pending', 'verified', 'lapsed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_revocable');
  END IF;

  UPDATE public.domain_claims
     SET status = 'revoked', revoked_at = now(), revoked_by = v_uid, revoke_reason = v_reason,
         updated_at = now()
   WHERE id = v_row.id;

  PERFORM public.log_admin_action(
    'domain_claim.revoke',
    'domain_claim',
    v_row.id::text,
    jsonb_build_object(
      'organization_id', v_row.organization_id,
      'domain', v_row.domain,
      'before', jsonb_build_object('status', v_row.status),
      'after', jsonb_build_object('status', 'revoked'),
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object('success', true, 'claim_id', v_row.id, 'status', 'revoked');
END;
$function$;

CREATE OR REPLACE FUNCTION public._domain_claim_record_check(
  p_claim uuid,
  p_org uuid,
  p_answers text[],
  p_resolver_ok boolean,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_row public.domain_claims;
  v_found boolean;
  v_result text;
  v_misses integer;
  v_status text;
  v_counted timestamptz;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('manual', 'recheck') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_source');
  END IF;

  SELECT * INTO v_row FROM public.domain_claims c
   WHERE c.id = p_claim AND c.organization_id = p_org
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_row.status NOT IN ('pending', 'verified', 'lapsed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_checkable');
  END IF;

  -- A resolver outage is never a miss.
  IF p_resolver_ok IS NOT TRUE THEN
    UPDATE public.domain_claims
       SET last_check_result = 'resolver_unavailable', last_checked_at = now(), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'result', 'resolver_unavailable', 'status', v_row.status);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM unnest(coalesce(p_answers, ARRAY[]::text[])) AS a(answer)
     WHERE btrim(a.answer) = v_row.token
  ) INTO v_found;

  IF v_found THEN
    IF v_row.status = 'verified' THEN
      UPDATE public.domain_claims
         SET consecutive_misses = 0, last_miss_counted_at = NULL, last_check_result = 'verified',
             last_checked_at = now(), updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('success', true, 'result', 'verified', 'status', 'verified');
    END IF;
    BEGIN
      UPDATE public.domain_claims
         SET status = 'verified', verified_at = now(), consecutive_misses = 0,
             last_miss_counted_at = NULL, last_check_result = 'verified',
             last_checked_at = now(), updated_at = now()
       WHERE id = v_row.id;
    EXCEPTION WHEN unique_violation THEN
      -- Another organization verified this domain first. This row keeps its status.
      UPDATE public.domain_claims
         SET last_check_result = 'domain_taken', last_checked_at = now(), updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('success', true, 'result', 'domain_taken', 'status', v_row.status);
    END;
    RETURN jsonb_build_object('success', true, 'result', 'verified', 'status', 'verified');
  END IF;

  SELECT CASE WHEN EXISTS (
           SELECT 1 FROM unnest(coalesce(p_answers, ARRAY[]::text[])) AS a(answer)
            WHERE left(btrim(a.answer), length('keepr-domain-verification=')) = 'keepr-domain-verification='
         ) THEN 'mismatch' ELSE 'not_found' END
    INTO v_result;

  v_misses := v_row.consecutive_misses;
  v_status := v_row.status;
  v_counted := v_row.last_miss_counted_at;
  IF v_row.status = 'verified' AND p_source = 'recheck'
     AND (v_row.last_miss_counted_at IS NULL OR v_row.last_miss_counted_at <= now() - interval '20 hours') THEN
    v_misses := v_misses + 1;
    v_counted := now();
    IF v_misses >= 3 THEN
      v_status := 'lapsed';
    END IF;
  END IF;

  UPDATE public.domain_claims
     SET last_check_result = v_result, consecutive_misses = v_misses, last_miss_counted_at = v_counted,
         status = v_status, last_checked_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('success', true, 'result', v_result, 'status', v_status,
                            'consecutive_misses', v_misses);
END;
$function$;

DROP FUNCTION IF EXISTS public._domain_capture_switch(uuid);
DROP FUNCTION IF EXISTS public._domain_capture_due(integer);
DROP FUNCTION IF EXISTS public._domain_capture_mark_notice(uuid, text);
DROP FUNCTION IF EXISTS public.caller_capture_notice();
DROP FUNCTION IF EXISTS public.domain_capture_opt_out_self(uuid);
DROP FUNCTION IF EXISTS public.domain_capture_cancel(uuid);
DROP FUNCTION IF EXISTS public.domain_capture_start(uuid, uuid, uuid[]);
DROP FUNCTION IF EXISTS public.domain_capture_candidates(uuid, uuid);
DROP FUNCTION IF EXISTS public._domain_capture_eval(uuid, uuid, text);
DROP FUNCTION IF EXISTS public._domain_capture_billing_ready();
DROP TABLE IF EXISTS public.domain_capture_switches;
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_provisioned_by_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_provisioned_by_check
  CHECK (provisioned_by IS NULL OR provisioned_by = ANY (ARRAY['manual', 'scim', 'jit', 'invite']::text[]));
