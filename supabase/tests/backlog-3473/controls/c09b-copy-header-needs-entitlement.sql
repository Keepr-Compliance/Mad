-- C9b (Addendum A): the submitted copy's header needs the organization's
-- entitlement -- the database floor under the desktop's fail-open gate.
--   T2 agent (team, no override, plan row false): header on its own
--   uploading submission S_t2 (no header yet)                        : RLS
--       (submitter ✓, uploading ✓, no header ✓: only entitlement refuses)
-- The positive case (T1, entitled) is C9p.
-- Mutant: m14 (header without the check_feature_access term).

SELECT pg_temp.act_as(pg_temp.id('u_t2_agent'));
SELECT pg_temp.expect('C9b header on a non-entitled org',
  format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', pg_temp.id('s_t2'), 'c09b'), 'RLS');
SELECT pg_temp.act_owner();
DO $post$
BEGIN
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_checklists WHERE submission_id = pg_temp.id('s_t2')),
                        'no header on S_t2');
END
$post$;
