-- harness: drift
-- C9 (SR C-2): a read rule whose USING differs from production makes the
-- migration abort before it changes anything. The harness alters the
-- transaction_submissions rule's USING (keeping its roles {public}), then runs
-- the migration inside an EXECUTE that records its error in t3759_drift.
SELECT pg_temp.check('c9 migration refused the drifted rule',
  (SELECT err FROM t3759_drift) ~ '^3759 pre-check: read rule transaction_submissions\.transaction_submissions_select_public has a different USING',
  (SELECT coalesce(err, '<no error>') FROM t3759_drift));
SELECT pg_temp.check('c9 nothing changed: anon still has EXECUTE',
  pg_temp.can_exec('anon', 'public.can_review_submission(uuid)'), pg_temp.acl('public.can_review_submission(uuid)'));
