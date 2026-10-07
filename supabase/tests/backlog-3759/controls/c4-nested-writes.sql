-- C4: writes whose rules read transaction_submissions under RLS still work.
SELECT pg_temp.expect('c4 agent adds a message to its uploading submission', 'authenticated', pg_temp.id('u_agent'),
  'INSERT INTO public.submission_messages (submission_id) VALUES (''{s_upl}'')', 'OK rows=1');
SELECT pg_temp.expect('c4 agent adds an attachment to its uploading submission', 'authenticated', pg_temp.id('u_agent'),
  'INSERT INTO public.submission_attachments (submission_id, filename, storage_path) VALUES (''{s_upl}'', ''a.pdf'', ''{o_main}/{s_upl}/a.pdf'')', 'OK rows=1');
SELECT pg_temp.expect('c4 broker comments on a submission', 'authenticated', pg_temp.id('u_broker'),
  'INSERT INTO public.submission_comments (submission_id, user_id, content) VALUES (''{s_sub}'', ''{u_broker}'', ''c'')', 'OK rows=1');
SELECT pg_temp.expect('c4 agent updates its uploading submission', 'authenticated', pg_temp.id('u_agent'),
  'UPDATE public.transaction_submissions SET property_address = ''3 Test St'' WHERE id = ''{s_upl}''', 'OK rows=1');
