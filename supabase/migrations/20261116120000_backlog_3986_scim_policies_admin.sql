-- ============================================================================
-- Migration: SCIM token policy admits brokerage roles admin AND it_admin
-- Backlog: BACKLOG-3986 (QA fix). Version granted by the coordinator.
--
-- The portal's SCIM gate (broker-portal/lib/scim-access.ts, SCIM_ADMIN_ROLES)
-- admits organization roles 'admin' and 'it_admin'. The row-level policy on
-- public.scim_tokens admitted 'it_admin' only, so an active admin passed the
-- app gate and the token insert was then refused by the policy.
--
-- Changes ONE policy expression:
--   public.scim_tokens  "IT admins can manage SCIM tokens"  (cmd ALL, TO authenticated)
--     role = 'it_admin'  ->  role IN ('admin', 'it_admin')
--   The org match, the (SELECT auth.uid()) caller match and
--   public.member_status_grants_access(license_status) are restated unchanged.
--   No WITH CHECK before, none after: USING also governs inserted/updated rows.
--   The policy name, command and roles are unchanged.
--
-- Not changed: public.scim_sync_log "Admins can view SCIM sync logs" already
-- admits ('admin', 'it_admin'); the POSTCHECK asserts it.
--
-- Pre-check: stops unless the policy is at its 20261014002359 (BACKLOG-3917)
-- expression, or already at this file's expression (a second run).
-- Grants: no function or table is created; nothing to revoke.
-- Idempotent: safe to apply twice.
-- Apply as one transaction. No BEGIN/COMMIT here.
--
-- Rollback: supabase/tests/backlog-3986/rollback-scim-policies-admin.sql
--   (restores the 20261014002359 expression verbatim).
-- Controls: supabase/tests/backlog-3986/controls-scim-policies.sql
-- ============================================================================

DO $pre$
DECLARE
  q text;
  n int;
BEGIN
  SELECT count(*), max(qual) INTO n, q
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'scim_tokens'
     AND policyname = 'IT admins can manage SCIM tokens';
  IF n <> 1 THEN
    RAISE EXCEPTION 'BACKLOG-3986 pre-check: expected 1 policy "IT admins can manage SCIM tokens" on public.scim_tokens, found %', n;
  END IF;
  IF md5(q) = '650dd386970cc49956848392f8c5889f' THEN
    RAISE NOTICE 'BACKLOG-3986 pre-check: scim_tokens policy at its 20261014002359 expression';
  ELSIF position('''admin''::' in q) > 0 AND position('''it_admin''::' in q) > 0
        AND position('member_status_grants_access' in q) > 0 THEN
    RAISE NOTICE 'BACKLOG-3986 pre-check: scim_tokens policy already admits admin and it_admin (second run)';
  ELSE
    RAISE EXCEPTION 'BACKLOG-3986 pre-check: scim_tokens policy expression is not the expected one: %', q;
  END IF;
END
$pre$;

ALTER POLICY "IT admins can manage SCIM tokens" ON public.scim_tokens
  USING (EXISTS (
    SELECT 1
      FROM public.organization_members token_manager
     WHERE token_manager.organization_id = scim_tokens.organization_id
       AND token_manager.user_id = (SELECT auth.uid())
       AND token_manager.role IN ('admin', 'it_admin')
       AND public.member_status_grants_access(token_manager.license_status)));

DO $post$
DECLARE
  r record;
  t text;
  n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['scim_tokens', 'scim_sync_log'] LOOP
    n := 0;
    FOR r IN
      SELECT policyname, cmd, roles::text AS roles, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
       ORDER BY policyname
    LOOP
      n := n + 1;
      RAISE NOTICE 'BACKLOG-3986 post-check: public.% policy "%" cmd=% roles=% qual=% with_check=%',
        t, r.policyname, r.cmd, r.roles, r.qual, coalesce(r.with_check, '<none>');
      IF r.roles <> '{authenticated}' THEN
        RAISE EXCEPTION 'BACKLOG-3986 post-check: public.% policy "%" roles are %', t, r.policyname, r.roles;
      END IF;
      IF r.with_check IS NOT NULL THEN
        RAISE EXCEPTION 'BACKLOG-3986 post-check: public.% policy "%" has an unexpected WITH CHECK', t, r.policyname;
      END IF;
      IF position('''admin''::' in r.qual) = 0
         OR position('''it_admin''::' in r.qual) = 0
         OR position('''agent''' in r.qual) > 0
         OR position('''broker''' in r.qual) > 0
         OR position('member_status_grants_access' in r.qual) = 0
         OR position('auth.uid()' in r.qual) = 0
         OR position(t || '.organization_id' in r.qual) = 0 THEN
        RAISE EXCEPTION 'BACKLOG-3986 post-check: public.% policy "%" expression is not admin+it_admin with org match, caller match and status check: %',
          t, r.policyname, r.qual;
      END IF;
    END LOOP;
    IF n <> 1 THEN
      RAISE EXCEPTION 'BACKLOG-3986 post-check: expected 1 policy on public.%, found %', t, n;
    END IF;
  END LOOP;
  IF (SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scim_tokens'
        AND policyname = 'IT admins can manage SCIM tokens') <> 'ALL' THEN
    RAISE EXCEPTION 'BACKLOG-3986 post-check: scim_tokens policy command changed';
  END IF;
END
$post$;
