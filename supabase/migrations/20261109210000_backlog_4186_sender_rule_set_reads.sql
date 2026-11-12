-- ============================================================
-- BACKLOG-4186 PR A: read RPCs for the admin-portal sender-rule page
--
-- The 4175 tables (sender_rule_sets, sender_rule_set_pins) are closed to every client role. The
-- admin page reads them through these two functions only:
--   sender_rule_set_admin_state()             every version (newest first, at most 200), the
--                                             released version and every pin
--   sender_rule_set_admin_content(p_version)  one version's content, or NULL
--
-- Gate: any grant on the 'sender-rules' report reads (owner, editor, viewer; founder decision
-- 2026-11-09). The gate is written as report_my_access(...) IS NULL -> 42501. Do not rewrite it as
-- NOT IN (...), <> 'owner' or NOT (... IN (...)): report_my_access is NULL for a user with no
-- grant, those forms evaluate to NULL, and plpgsql does not raise on NULL, so they let that user in.
-- Writes stay owner-only (publish / pin / revert_all in 20261107235503).
--
-- Never returned: published_by, pinned_by. Org names come from a LEFT JOIN because canary_org has
-- no FK (a deleted org keeps its version row, with a NULL name).
--
-- No new table, so no TRUNCATE revoke. Needs 20261107235503 (BACKLOG-4175) and 20261105100000
-- (BACKLOG-4144, report_my_access).
-- Apply to prod BEFORE int-portal/sender-rule-editor merges to develop: develop deploys against
-- prod, and without these functions the page shows its "could not be read" panel.
--
-- Rollback script: supabase/tests/backlog-4186/rollback-4186.sql
-- Idempotent: safe to apply twice.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sender_rule_set_admin_state()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR public.report_my_access('sender-rules') IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'released_version',
      (SELECT max(r.version) FROM public.sender_rule_sets r WHERE r.released),
    'truncated',
      (SELECT count(*) FROM public.sender_rule_sets t) > 200,
    'versions',
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'version', x.version,
          'released', x.released,
          'bundled', x.bundled,
          'canary_org', x.canary_org,
          'canary_org_name', x.canary_org_name,
          'published_at', x.published_at) ORDER BY x.version DESC), '[]'::jsonb)
       FROM (
         SELECT s.version, s.released, s.bundled, s.canary_org, o.name AS canary_org_name, s.published_at
         FROM public.sender_rule_sets s
         LEFT JOIN public.organizations o ON o.id = s.canary_org
         ORDER BY s.version DESC
         LIMIT 200
       ) x),
    'pins',
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'org_id', p.org_id,
          'org_name', po.name,
          'version', p.version,
          'pinned_at', p.pinned_at) ORDER BY p.pinned_at DESC, p.org_id), '[]'::jsonb)
       FROM public.sender_rule_set_pins p
       LEFT JOIN public.organizations po ON po.id = p.org_id)
  );
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.sender_rule_set_admin_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sender_rule_set_admin_state() TO authenticated;

COMMENT ON FUNCTION public.sender_rule_set_admin_state() IS
  'BACKLOG-4186: any sender-rules report grant. {released_version, truncated, versions (newest 200), pins}. Never returns published_by or pinned_by.';

CREATE OR REPLACE FUNCTION public.sender_rule_set_admin_content(p_version BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR public.report_my_access('sender-rules') IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  RETURN (SELECT c.content FROM public.sender_rule_sets c WHERE c.version = p_version);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.sender_rule_set_admin_content(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sender_rule_set_admin_content(BIGINT) TO authenticated;

COMMENT ON FUNCTION public.sender_rule_set_admin_content(BIGINT) IS
  'BACKLOG-4186: any sender-rules report grant. The content of one version, or NULL.';
