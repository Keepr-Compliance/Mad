-- BACKLOG-3962 PR1: brokerage domain claims, proved by a DNS TXT record.
--
-- Plan pm_comments f55e3b55 (section 2), SR plan review 193b87d8 (R1, R5, R11).
--
-- public.domain_claims: one row per (organization, domain) attempt.
--   status pending -> verified (DNS proof) -> lapsed (3 spaced misses on re-check)
--          pending | verified | lapsed -> withdrawn (org admin) | revoked (staff)
--   One VERIFIED claim per domain across all organizations (partial unique index). Several
--   organizations may hold PENDING claims for one domain; the first to verify wins.
--   The token is generated here, never chosen by a client. It is public once it is in DNS.
--
-- Functions (every one SET search_path TO '', REVOKE from PUBLIC and anon, explicit GRANT):
--   _normalize_claim_domain(text)            internal, IMMUTABLE
--   _is_consumer_email_domain(text)          internal, IMMUTABLE
--   domain_claim_create(uuid, text)          authenticated; caller is an admin of the org
--   domain_claim_withdraw(uuid)              authenticated; caller is an admin of the claim's org
--   _domain_claim_begin_check(uuid, uuid)    server role only (checked inside)
--   _domain_claim_record_check(uuid, uuid, text[], boolean, text)
--                                            server role only (checked inside)
--   _domain_claims_due_for_recheck(integer)  server role only (checked inside)
--   admin_list_domain_claims(uuid)           authenticated; staff with organizations.view
--   admin_revoke_domain_claim(uuid, text)    authenticated; staff with organizations.edit
--
-- Rollback: supabase/tests/backlog-3962/rollback-3962-pr1.sql. Harness: supabase/tests/backlog-3962/.

-- Pre-check: nothing here may already exist, and the helpers the policy and the caller checks
-- rely on are the bodies read on prod and keepr-test (2026-11-10).
DO $guard$
DECLARE v text;
BEGIN
  IF to_regclass('public.domain_claims') IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-3962: public.domain_claims already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('_normalize_claim_domain', '_is_consumer_email_domain',
                                'domain_claim_create', 'domain_claim_withdraw',
                                '_domain_claim_begin_check', '_domain_claim_record_check',
                                '_domain_claims_due_for_recheck', 'admin_list_domain_claims',
                                'admin_revoke_domain_claim')) THEN
    RAISE EXCEPTION 'BACKLOG-3962: a domain claim function already exists';
  END IF;
  -- is_org_admin ties its first argument to auth.uid() and requires an access-granting status.
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.is_org_admin(uuid, uuid)'::regprocedure;
  IF v IS DISTINCT FROM 'e45b66de52f2f2dfa4d55165c6eb1796' THEN
    RAISE EXCEPTION 'BACKLOG-3962: is_org_admin md5 % is not the expected body', v;
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.has_permission(uuid, text)'::regprocedure;
  IF v IS DISTINCT FROM 'cfc4ffb201632d3df5aad1f349c18b8e' THEN
    RAISE EXCEPTION 'BACKLOG-3962: has_permission md5 % is not the expected body', v;
  END IF;
  -- both staff functions gate on has_internal_role.
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.has_internal_role(uuid)'::regprocedure;
  IF v IS DISTINCT FROM '221786001ca8ce4767112e1175cc6ece' THEN
    RAISE EXCEPTION 'BACKLOG-3962: has_internal_role md5 % is not the expected body', v;
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc
   WHERE oid = 'public.log_admin_action(text, text, text, jsonb, inet, text)'::regprocedure;
  IF v IS DISTINCT FROM '4793571138164901ad451d3cc09b2224' THEN
    RAISE EXCEPTION 'BACKLOG-3962: log_admin_action md5 % is not the expected body', v;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE public.domain_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain text NOT NULL,
  token text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_check_result text,
  consecutive_misses integer NOT NULL DEFAULT 0,
  -- R5: the time of the last re-check miss that was COUNTED. last_checked_at is the 30 s rate
  -- limit and is stamped by every check; this one decides whether a miss is spaced enough.
  last_miss_counted_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoke_reason text,
  CONSTRAINT domain_claims_token_key UNIQUE (token),
  CONSTRAINT domain_claims_status_check
    CHECK (status IN ('pending', 'verified', 'lapsed', 'withdrawn', 'revoked')),
  CONSTRAINT domain_claims_result_check
    CHECK (last_check_result IS NULL OR last_check_result IN
           ('not_found', 'mismatch', 'resolver_unavailable', 'verified', 'domain_taken')),
  -- Same shape as _normalize_claim_domain: lowercase ASCII LDH labels, at least two labels,
  -- a final label with a letter, <= 253 characters.
  CONSTRAINT domain_claims_domain_check CHECK (
    domain = lower(domain)
    AND length(domain) <= 253
    AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    AND split_part(domain, '.', -1) ~ '[a-z]'
  ),
  CONSTRAINT domain_claims_token_check CHECK (token ~ '^keepr-domain-verification=[0-9a-f]{48}$'),
  CONSTRAINT domain_claims_misses_check CHECK (consecutive_misses >= 0)
);

-- One verified claim per domain, across all organizations.
CREATE UNIQUE INDEX domain_claims_one_verified_per_domain
  ON public.domain_claims (domain) WHERE status = 'verified';
-- One live claim per (organization, domain).
CREATE UNIQUE INDEX domain_claims_one_live_per_org_domain
  ON public.domain_claims (organization_id, domain) WHERE status IN ('pending', 'verified', 'lapsed');
-- The re-check reads verified and lapsed rows by age.
CREATE INDEX domain_claims_status_last_checked
  ON public.domain_claims (status, last_checked_at);

ALTER TABLE public.domain_claims ENABLE ROW LEVEL SECURITY;

-- The org's own admins read their claims (the record value is shown to them by design).
-- No insert, update or delete policy: every write goes through a function below.
CREATE POLICY domain_claims_select_org_admin ON public.domain_claims
  FOR SELECT TO authenticated
  USING (public.is_org_admin((SELECT auth.uid()), organization_id));

REVOKE ALL ON TABLE public.domain_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.domain_claims TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.domain_claims
  FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- The SQL half of the one normalisation rule (broker-portal/lib/domain/normalize.ts is the other
-- half, which also converts a Unicode name to its A-label). Trim, lowercase, strip ONE trailing
-- dot; refuse anything with a scheme, path, port, '@' or whitespace; return NULL when the result
-- is not the A-label shape the table accepts.
CREATE FUNCTION public._normalize_claim_domain(p_input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $function$
DECLARE v text;
BEGIN
  IF p_input IS NULL THEN
    RETURN NULL;
  END IF;
  v := lower(btrim(p_input));
  IF v ~ '[[:space:]/:@?#\\]' THEN
    RETURN NULL;
  END IF;
  IF right(v, 1) = '.' THEN
    v := left(v, -1);
  END IF;
  IF v = ''
     OR length(v) > 253
     OR v !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
     OR split_part(v, '.', -1) !~ '[a-z]' THEN
    RETURN NULL;
  END IF;
  RETURN v;
END;
$function$;

-- Consumer and ISP mail domains, copied from electron/utils/senderFilter/bundledRules.ts
-- (freeMailDomains). A parity test reads that file and fails when an entry is missing here.
-- Deliberately NOT read from sender_rule_sets: a shorter published rule set must never open a
-- consumer domain to claims.
CREATE FUNCTION public._is_consumer_email_domain(p_domain text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
  SELECT lower(btrim(coalesce(p_domain, ''))) = ANY (ARRAY[
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
    'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
    'yandex.com', 'fastmail.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
    'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net'
  ]::text[]);
$function$;

-- ---------------------------------------------------------------------------
-- Org admin functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.domain_claim_create(p_org uuid, p_domain text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_domain text;
  v_row public.domain_claims;
  v_live integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_org IS NULL OR NOT public.is_org_admin(v_uid, p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o
              WHERE o.id = p_org AND o.personal_owner_user_id IS NOT NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  v_domain := public._normalize_claim_domain(p_domain);
  IF v_domain IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_domain');
  END IF;
  IF public._is_consumer_email_domain(v_domain) THEN
    RETURN jsonb_build_object('success', false, 'error', 'consumer_domain');
  END IF;

  -- This org already has a live claim on the domain: hand it back unchanged.
  SELECT * INTO v_row FROM public.domain_claims c
   WHERE c.organization_id = p_org AND c.domain = v_domain
     AND c.status IN ('pending', 'verified', 'lapsed');
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'existing', true, 'claim_id', v_row.id,
      'domain', v_row.domain, 'status', v_row.status,
      'record_name', '_keepr.' || v_row.domain, 'record_value', v_row.token);
  END IF;

  IF EXISTS (SELECT 1 FROM public.domain_claims c
              WHERE c.domain = v_domain AND c.status = 'verified' AND c.organization_id <> p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'domain_taken');
  END IF;

  SELECT count(*) INTO v_live FROM public.domain_claims c
   WHERE c.organization_id = p_org AND c.status IN ('pending', 'verified', 'lapsed');
  IF v_live >= 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'too_many_claims');
  END IF;

  BEGIN
    INSERT INTO public.domain_claims (organization_id, domain, token, created_by)
    VALUES (p_org, v_domain,
            'keepr-domain-verification=' || encode(extensions.gen_random_bytes(24), 'hex'),
            v_uid)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent create for the same (org, domain) won the race.
    RETURN jsonb_build_object('success', false, 'error', 'try_again');
  END;

  RETURN jsonb_build_object('success', true, 'existing', false, 'claim_id', v_row.id,
    'domain', v_row.domain, 'status', v_row.status,
    'record_name', '_keepr.' || v_row.domain, 'record_value', v_row.token);
END;
$function$;

CREATE FUNCTION public.domain_claim_withdraw(p_claim uuid)
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

-- ---------------------------------------------------------------------------
-- Server-role functions (the Check button and the re-check). Granted to the server role only,
-- AND each refuses any other role inside (R1), so a later grant cannot open them.
-- ---------------------------------------------------------------------------

-- Atomically refuses a second check within 30 s; otherwise stamps last_checked_at.
-- Returns the domain to query, never the token.
CREATE FUNCTION public._domain_claim_begin_check(p_claim uuid, p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_domain text;
  v_status text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  UPDATE public.domain_claims c
     SET last_checked_at = now(), updated_at = now()
   WHERE c.id = p_claim
     AND c.organization_id = p_org
     AND c.status IN ('pending', 'verified', 'lapsed')
     AND (c.last_checked_at IS NULL OR c.last_checked_at <= now() - interval '30 seconds')
  RETURNING c.domain INTO v_domain;
  IF v_domain IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'domain', v_domain);
  END IF;

  SELECT c.status INTO v_status FROM public.domain_claims c
   WHERE c.id = p_claim AND c.organization_id = p_org;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_status NOT IN ('pending', 'verified', 'lapsed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_checkable');
  END IF;
  RETURN jsonb_build_object('success', false, 'error', 'too_soon');
END;
$function$;

-- Records one DNS answer set against ONE claim row. The token is read from that row, never from
-- a parameter; a pass is exact equality of a trimmed answer with it.
--   p_source 'manual'  the Check button: reports the result, never counts a miss (R5).
--   p_source 'recheck' the daily re-check: a miss on a verified row counts only when the last
--                      counted miss is >= 20 h old; the third counted miss lapses the claim.
CREATE FUNCTION public._domain_claim_record_check(
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

-- Verified and lapsed claims not checked for 20 h. Selects and stamps in one statement
-- (FOR UPDATE SKIP LOCKED), so two overlapping runs never take the same row.
CREATE FUNCTION public._domain_claims_due_for_recheck(p_limit integer)
RETURNS TABLE (claim_id uuid, organization_id uuid, domain text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT c.id FROM public.domain_claims c
     WHERE c.status IN ('verified', 'lapsed')
       AND (c.last_checked_at IS NULL OR c.last_checked_at < now() - interval '20 hours')
     ORDER BY c.last_checked_at NULLS FIRST
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.domain_claims d
     SET last_checked_at = now(), updated_at = now()
    FROM due
   WHERE d.id = due.id
  RETURNING d.id, d.organization_id, d.domain;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Staff (admin portal) functions
-- ---------------------------------------------------------------------------

-- Claims of one organization, without the token.
CREATE FUNCTION public.admin_list_domain_claims(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF NOT public.has_internal_role(v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_internal_user');
  END IF;
  IF NOT public.has_permission(v_uid, 'organizations.view') THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_permissions');
  END IF;
  RETURN jsonb_build_object('success', true, 'claims', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id, 'domain', c.domain, 'status', c.status,
             'verified_at', c.verified_at, 'last_checked_at', c.last_checked_at,
             'last_check_result', c.last_check_result, 'consecutive_misses', c.consecutive_misses,
             'created_at', c.created_at, 'revoked_at', c.revoked_at, 'revoke_reason', c.revoke_reason)
           ORDER BY c.created_at DESC)
      FROM public.domain_claims c WHERE c.organization_id = p_org), '[]'::jsonb));
END;
$function$;

-- Staff revoke: frees the domain at once. Needs a reason; audit-logged.
CREATE FUNCTION public.admin_revoke_domain_claim(p_claim uuid, p_reason text)
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

-- ---------------------------------------------------------------------------
-- Grants: revoke by default, then grant only the callers.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._normalize_claim_domain(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._is_consumer_email_domain(text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.domain_claim_create(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_claim_create(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.domain_claim_withdraw(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_claim_withdraw(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public._domain_claim_begin_check(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_claim_begin_check(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public._domain_claim_record_check(uuid, uuid, text[], boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_claim_record_check(uuid, uuid, text[], boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public._domain_claims_due_for_recheck(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_claims_due_for_recheck(integer) TO service_role;

REVOKE ALL ON FUNCTION public.admin_list_domain_claims(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_domain_claims(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_revoke_domain_claim(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_domain_claim(uuid, text) TO authenticated;

-- Post-check (R11): every new function, every client role, the table, the definer settings.
-- POSTCHECK BEGIN
DO $guard$
DECLARE
  f text;
  v_client_ok text[] := ARRAY[
    'public.domain_claim_create(uuid, text)',
    'public.domain_claim_withdraw(uuid)',
    'public.admin_list_domain_claims(uuid)',
    'public.admin_revoke_domain_claim(uuid, text)'];
  v_closed text[] := ARRAY[
    'public._normalize_claim_domain(text)',
    'public._is_consumer_email_domain(text)',
    'public._domain_claim_begin_check(uuid, uuid)',
    'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)',
    'public._domain_claims_due_for_recheck(integer)'];
  v_definer text[] := ARRAY[
    'public.domain_claim_create(uuid, text)',
    'public.domain_claim_withdraw(uuid)',
    'public.admin_list_domain_claims(uuid)',
    'public.admin_revoke_domain_claim(uuid, text)',
    'public._domain_claim_begin_check(uuid, uuid)',
    'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)',
    'public._domain_claims_due_for_recheck(integer)'];
BEGIN
  FOREACH f IN ARRAY v_client_ok || v_closed LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: anon can execute %', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure
                     AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'BACKLOG-3962: % does not pin an empty search_path', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_closed LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: authenticated can execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_client_ok LOOP
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: authenticated cannot execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_definer LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
      RAISE EXCEPTION 'BACKLOG-3962: % is not SECURITY DEFINER', f;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.domain_claims', 'SELECT')
     OR has_table_privilege('anon', 'public.domain_claims', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'INSERT')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'DELETE') THEN
    RAISE EXCEPTION 'BACKLOG-3962: a client role has a write or truncate grant on domain_claims';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.domain_claims'::regclass) THEN
    RAISE EXCEPTION 'BACKLOG-3962: row level security is off on domain_claims';
  END IF;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.domain_claims'::regclass) <> 1 THEN
    RAISE EXCEPTION 'BACKLOG-3962: domain_claims must carry exactly one policy';
  END IF;
END
$guard$;
-- POSTCHECK END
