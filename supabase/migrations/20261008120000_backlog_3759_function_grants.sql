-- BACKLOG-3759: signed-out callers lose the submission reviewer check, and the
-- three submission read rules apply to signed-in users only.
--
-- Apply as ONE transaction (`psql -1 -f <file>`, or the whole file in one SQL
-- editor run). It opens none of its own, and it is safe to run twice: the
-- pre-check accepts each read rule in either its old or its new role scope.
--
--   1. Pre-check. Aborts unless:
--        - public.can_review_submission(uuid) and
--          public.can_edit_checklist_templates(uuid) exist;
--        - each of the three read rules below exists, its USING expression
--          hashes to the value recorded here (md5 of pg_policies.qual), and
--          its roles are {public} (before) or {authenticated} (already applied).
--      A rule whose text has drifted aborts the apply instead of being
--      re-scoped blind.
--
--   2. The three read rules move from TO public to TO authenticated with
--      ALTER POLICY ... TO. Only the roles change; the USING expressions are
--      not restated and are left byte-for-byte as they are:
--        transaction_submissions.transaction_submissions_select_public
--        submission_messages.message_access_via_submission
--        submission_attachments.attachment_access_via_submission
--      A signed-out (anon) read of these tables then has no applicable read
--      rule and returns no rows, without calling the reviewer check.
--
--   3. EXECUTE on public.can_review_submission(uuid) is revoked from PUBLIC
--      and anon, and granted to authenticated and service_role.
--      This SUPERSEDES the "anon keeps EXECUTE" note in
--      20260925073000_backlog_3477_submission_checklist_review.sql (section 3):
--      that grant existed only because the read rules in (2) applied to every
--      role. With (2) in place no anon-applicable rule calls the function.
--      Do not restore the anon grant without moving the rules back.
--
--   4. EXECUTE on public.can_edit_checklist_templates(uuid) is restated:
--      revoked from PUBLIC and anon, granted to authenticated and
--      service_role. Its grants are already these
--      (20260921101757_backlog_3473_transaction_checklists.sql); this makes the
--      latest definition carry them explicitly. No effect on any database.
--
--   5. Post-check. Raises unless the end state is: the three rules
--      {authenticated} with unchanged USING hashes; both functions not
--      executable by anon or PUBLIC, executable by authenticated and
--      service_role.
--
-- Rollback:
--   ALTER POLICY transaction_submissions_select_public ON public.transaction_submissions TO public;
--   ALTER POLICY message_access_via_submission ON public.submission_messages TO public;
--   ALTER POLICY attachment_access_via_submission ON public.submission_attachments TO public;
--   GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO anon;

-- 1. Pre-check ---------------------------------------------------------------
DO $pre3759$
DECLARE
  r record;
  v_roles text;
  v_md5 text;
BEGIN
  IF to_regprocedure('public.can_review_submission(uuid)') IS NULL THEN
    RAISE EXCEPTION '3759 pre-check: public.can_review_submission(uuid) is missing';
  END IF;
  IF to_regprocedure('public.can_edit_checklist_templates(uuid)') IS NULL THEN
    RAISE EXCEPTION '3759 pre-check: public.can_edit_checklist_templates(uuid) is missing';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('transaction_submissions', 'transaction_submissions_select_public', 'eb31142ae1935bb013b94c5a837812a8'),
      ('submission_messages',     'message_access_via_submission',         '1363e5e79110edb649e6f63f8633652d'),
      ('submission_attachments',  'attachment_access_via_submission',      'aadbffd22c8c8f2e7a7d440c3f45ddb7')
    ) AS t(tbl, pol, expected_md5)
  LOOP
    SELECT p.roles::text, md5(p.qual) INTO v_roles, v_md5
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = r.pol AND p.cmd = 'SELECT';
    IF NOT FOUND THEN
      RAISE EXCEPTION '3759 pre-check: read rule %.% is missing', r.tbl, r.pol;
    END IF;
    IF v_md5 IS DISTINCT FROM r.expected_md5 THEN
      RAISE EXCEPTION '3759 pre-check: read rule %.% has a different USING expression (md5 %)', r.tbl, r.pol, v_md5;
    END IF;
    IF v_roles NOT IN ('{public}', '{authenticated}') THEN
      RAISE EXCEPTION '3759 pre-check: read rule %.% has roles %', r.tbl, r.pol, v_roles;
    END IF;
  END LOOP;
END
$pre3759$;

-- 2. Read rules: signed-in users only ----------------------------------------
ALTER POLICY transaction_submissions_select_public ON public.transaction_submissions TO authenticated;
ALTER POLICY message_access_via_submission ON public.submission_messages TO authenticated;
ALTER POLICY attachment_access_via_submission ON public.submission_attachments TO authenticated;

-- 3. Reviewer check: no anon EXECUTE ------------------------------------------
REVOKE EXECUTE ON FUNCTION public.can_review_submission(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO authenticated, service_role;

-- 4. Template-editor check: restated (no effect) -------------------------------
REVOKE EXECUTE ON FUNCTION public.can_edit_checklist_templates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_edit_checklist_templates(uuid) TO authenticated, service_role;

-- 5. Post-check --------------------------------------------------------------
DO $post3759$
DECLARE
  f regprocedure;
BEGIN
  IF (SELECT count(*) FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.cmd = 'SELECT'
         AND p.roles::text = '{authenticated}'
         AND (p.tablename, p.policyname, md5(p.qual)) IN (
           ('transaction_submissions', 'transaction_submissions_select_public', 'eb31142ae1935bb013b94c5a837812a8'),
           ('submission_messages',     'message_access_via_submission',         '1363e5e79110edb649e6f63f8633652d'),
           ('submission_attachments',  'attachment_access_via_submission',      'aadbffd22c8c8f2e7a7d440c3f45ddb7'))) <> 3 THEN
    RAISE EXCEPTION '3759 post-check: a read rule is not authenticated-only with its original USING';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.can_review_submission(uuid)'::regprocedure,
                           'public.can_edit_checklist_templates(uuid)'::regprocedure] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '3759 post-check: anon can execute a function';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '3759 post-check: PUBLIC can execute a function';
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '3759 post-check: authenticated cannot execute a function';
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION '3759 post-check: service_role cannot execute a function';
    END IF;
  END LOOP;
END
$post3759$;
