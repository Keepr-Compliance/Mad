-- C00: after the migration, the only INSERT-capable policy on
-- transaction_submissions other than the service role's FOR ALL policy is
-- agents_can_create_submissions, and its WITH CHECK carries the new terms.
-- Wrong implementation this catches: the new rule created BESIDE the old one
-- (policies are ORed, so the old rule would still admit everything) (m11).
DO $c00$
DECLARE
  names text;
  wc    text;
BEGIN
  SELECT string_agg(policyname, ',' ORDER BY policyname) INTO names
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'transaction_submissions'
     AND cmd IN ('INSERT', 'ALL');
  PERFORM pg_temp.check(names = 'agents_can_create_submissions,service_role_full_access_submissions',
                        format('C00 INSERT-capable policies, got %s', names));
  SELECT with_check INTO wc FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'transaction_submissions'
     AND policyname = 'agents_can_create_submissions';
  PERFORM pg_temp.check(wc LIKE '%''uploading''::text, ''submitted''::text%'
                        AND wc LIKE '%reviewed_by IS NULL%' AND wc LIKE '%reviewed_at IS NULL%'
                        AND wc LIKE '%review_notes IS NULL%'
                        AND wc LIKE '%personal_owner_user_id IS NULL%',
                        format('C00 WITH CHECK text, got %s', wc));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'status_history_append_only'
                                   AND tgrelid = 'public.transaction_submissions'::regclass),
                        'C00 the BACKLOG-3477 status_history trigger is present');
END
$c00$;
