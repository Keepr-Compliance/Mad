-- C3: signed-in read semantics are unchanged: the submitter sees its own rows,
-- a reviewer of the organization sees the organization's, a reviewer of
-- another organization sees none.
SELECT pg_temp.expect('c3 ' || who || ' ' || label, 'authenticated', pg_temp.id(who), q, 'OK rows=' || want)
FROM (VALUES
 ('transaction_submissions', 'SELECT id FROM public.transaction_submissions WHERE organization_id = ''{o_main}''', 3, 3, 0),
 ('submission_messages',     'SELECT id FROM public.submission_messages WHERE id = ''{m_sub}''', 1, 1, 0),
 ('submission_attachments',  'SELECT id FROM public.submission_attachments WHERE id = ''{a_sub}''', 1, 1, 0),
 ('submission_comments',     'SELECT id FROM public.submission_comments WHERE id = ''{c_sub}''', 1, 1, 0),
 ('storage object',          'SELECT id FROM storage.objects WHERE bucket_id = ''submission-attachments'' AND name LIKE ''{o_main}/{s_sub}/%''', 1, 1, 0)
) AS t(label, q, n_agent, n_broker, n_outsider),
LATERAL (VALUES ('u_agent', n_agent), ('u_broker', n_broker), ('u_outsider', n_outsider)) AS w(who, want);
-- The portal's reviewer check, signed in.
SELECT pg_temp.expect('c3 broker can_review_submission(o_main) = true', 'authenticated', pg_temp.id('u_broker'),
  'SELECT 1 WHERE public.can_review_submission(''{o_main}'')', 'OK rows=1');
SELECT pg_temp.expect('c3 outsider can_review_submission(o_main) = false', 'authenticated', pg_temp.id('u_outsider'),
  'SELECT 1 WHERE public.can_review_submission(''{o_main}'')', 'OK rows=0');
