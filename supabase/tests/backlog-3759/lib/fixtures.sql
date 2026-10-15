-- BACKLOG-3759 fixtures. Run inside the harness transaction, as postgres,
-- BEFORE the migration. Synthetic ids and addresses only; rows, never objects.
--   o_main:  the organization the submissions belong to
--   o_other: a second organization
--   u_agent:    agent in o_main, submitter of every submission
--   u_broker:   broker in o_main (a reviewer of o_main)
--   u_outsider: broker in o_other (a reviewer, but not of o_main)
--   s_upl: o_main, 'uploading'   s_sub: o_main, 'submitted'
--   s_v2:  o_main, 'resubmitted', version 2 of s_sub
--   m_sub / a_sub / c_sub: a message, attachment and comment on s_sub, plus
--   the storage object behind a_sub in the submission-attachments bucket.
INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_agent'),    'agent-3759@example.test',    'authenticated', 'authenticated'),
 (pg_temp.id('u_broker'),   'broker-3759@example.test',   'authenticated', 'authenticated'),
 (pg_temp.id('u_outsider'), 'outsider-3759@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
 (pg_temp.id('u_agent'),    'agent-3759@example.test',    'google', 'agent3759'),
 (pg_temp.id('u_broker'),   'broker-3759@example.test',   'google', 'broker3759'),
 (pg_temp.id('u_outsider'), 'outsider-3759@example.test', 'google', 'outsider3759');
INSERT INTO public.organizations (id, name, slug) VALUES
 (pg_temp.id('o_main'),  'Org 3759 main',  'org-3759-main'),
 (pg_temp.id('o_other'), 'Org 3759 other', 'org-3759-other');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 (pg_temp.id('o_main'),  pg_temp.id('u_agent'),    'agent'),
 (pg_temp.id('o_main'),  pg_temp.id('u_broker'),   'broker'),
 (pg_temp.id('o_other'), pg_temp.id('u_outsider'), 'broker');
INSERT INTO public.transaction_submissions
  (id, organization_id, submitted_by, local_transaction_id, property_address, status, parent_submission_id, version) VALUES
 (pg_temp.id('s_upl'), pg_temp.id('o_main'), pg_temp.id('u_agent'), 'lt-3759-upl', '1 Test St', 'uploading',   NULL, 1),
 (pg_temp.id('s_sub'), pg_temp.id('o_main'), pg_temp.id('u_agent'), 'lt-3759-sub', '2 Test St', 'submitted',   NULL, 1);
INSERT INTO public.transaction_submissions
  (id, organization_id, submitted_by, local_transaction_id, property_address, status, parent_submission_id, version) VALUES
 (pg_temp.id('s_v2'),  pg_temp.id('o_main'), pg_temp.id('u_agent'), 'lt-3759-sub', '2 Test St', 'resubmitted', pg_temp.id('s_sub'), 2);
INSERT INTO public.submission_messages (id, submission_id) VALUES
 (pg_temp.id('m_sub'), pg_temp.id('s_sub'));
INSERT INTO public.submission_attachments (id, submission_id, filename, storage_path) VALUES
 (pg_temp.id('a_sub'), pg_temp.id('s_sub'), 'doc.pdf',
  pg_temp.id('o_main') || '/' || pg_temp.id('s_sub') || '/doc.pdf');
INSERT INTO public.submission_comments (id, submission_id, user_id, content, is_internal) VALUES
 (pg_temp.id('c_sub'), pg_temp.id('s_sub'), pg_temp.id('u_broker'), 'comment 3759', false);
INSERT INTO storage.objects (bucket_id, name) VALUES
 ('submission-attachments', pg_temp.id('o_main') || '/' || pg_temp.id('s_sub') || '/doc.pdf');

-- The fixtures exist (as postgres), so a 0 for a caller below is RLS, not an empty table.
SELECT pg_temp.check('fixtures: 3 submissions, 1 message, 1 attachment, 1 comment, 1 object',
  (SELECT count(*) FROM public.transaction_submissions WHERE organization_id = pg_temp.id('o_main')) = 3
  AND (SELECT count(*) FROM public.submission_messages WHERE id = pg_temp.id('m_sub')) = 1
  AND (SELECT count(*) FROM public.submission_attachments WHERE id = pg_temp.id('a_sub')) = 1
  AND (SELECT count(*) FROM public.submission_comments WHERE id = pg_temp.id('c_sub')) = 1
  AND (SELECT count(*) FROM storage.objects WHERE bucket_id = 'submission-attachments'
         AND name = pg_temp.id('o_main') || '/' || pg_temp.id('s_sub') || '/doc.pdf') = 1);
