-- C12 (C6): the review role list lives in ONE place. Read from the catalog:
--   can_review_submission names broker, admin and it_admin;
--   each of the seven read rules calls it and names no role;
--   both reviewer functions call it and name no role.
-- Wrong implementation this catches: a rule or function with its own copy of
-- the list (which a later per-organization permission change would miss).
DO $c12$
DECLARE
  r record;
  src text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'can_review_submission';
  PERFORM pg_temp.check(src ~ '''broker''' AND src ~ '''admin''' AND src ~ '''it_admin''', 'C12 helper names the three roles');

  FOR r IN SELECT * FROM (VALUES
      ('transaction_submissions', 'transaction_submissions_select_public'),
      ('submission_messages', 'message_access_via_submission'),
      ('submission_attachments', 'attachment_access_via_submission'),
      ('submission_checklists', 'submission_checklists_select'),
      ('submission_checklist_items', 'submission_checklist_items_select'),
      ('submission_checklist_links', 'submission_checklist_links_select'),
      ('submission_checklist_link_members', 'submission_checklist_link_members_select')) v(tbl, pol) LOOP
    SELECT qual INTO src FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.pol AND cmd = 'SELECT';
    PERFORM pg_temp.check(src IS NOT NULL, format('C12 %s.%s exists', r.tbl, r.pol));
    PERFORM pg_temp.check(src ~ 'can_review_submission' AND src !~ '(broker|admin)''',
                          format('C12 %s.%s uses the helper and names no role: %s', r.tbl, r.pol, left(src, 200)));
  END LOOP;

  FOR r IN SELECT p.proname, p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('set_submission_checklist_reviewer_check', 'add_submission_checklist_at_review') LOOP
    PERFORM pg_temp.check(r.prosrc ~ 'public\.can_review_submission\(' AND r.prosrc !~ '''(broker|admin|it_admin)''',
                          'C12 ' || r.proname || ' uses the helper and names no role');
  END LOOP;
  PERFORM pg_temp.check((SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('set_submission_checklist_reviewer_check', 'add_submission_checklist_at_review')) = 2, 'C12 both functions exist');
END
$c12$;
