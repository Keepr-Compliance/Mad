-- Control (2b, RLS path): submission_checklists_insert calls check_feature_access.
-- t_org's Team plan has transaction_checklists off. A malformed override must be
-- ignored -> refused by RLS (42501), never 22007 from a cast inside the policy.
-- Positive half: a valid future override lets the same insert through, so the
-- refusal is the feature check and nothing else.
SELECT pg_temp.set_override(pg_temp.id('t_org'), 'transaction_checklists',
  '{"enabled": true, "paid_through": "2098-01-01T00:00:00Z"}');
SELECT pg_temp.check('valid override -> submitter may add a checklist', r = 'OK <null>', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_team'),
    'INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (''{s_upload}'', ''fx valid'')') r) s;
SELECT pg_temp.set_override(pg_temp.id('t_org'), 'transaction_checklists',
  '{"enabled": true, "paid_through": "soon"}');
SELECT pg_temp.check('malformed override -> RLS refusal 42501, not 22007', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_team'),
    'INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (''{s_upload}'', ''fx soon'')') r) s;
SELECT pg_temp.set_override(pg_temp.id('t_org'), 'transaction_checklists',
  '{"enabled": true, "paid_through": "2026-13-45T00:00:00Z"}');
SELECT pg_temp.check('invalid date override -> RLS refusal 42501, not 22008', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_team'),
    'INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (''{s_upload}'', ''fx bad date'')') r) s;
