-- C2 (+ SR C-3): every signed-out read path returns no rows and raises nothing.
SELECT pg_temp.expect('c2 anon ' || label, 'anon', NULL, q, 'OK rows=0') FROM (VALUES
 ('transaction_submissions select *', 'SELECT * FROM public.transaction_submissions'),
 ('desktop status poll (id = ANY)',   'SELECT id, status, review_notes, reviewed_by, reviewed_at FROM public.transaction_submissions WHERE id = ANY(ARRAY[''{s_sub}'',''{s_upl}'',''{s_v2}'']::uuid[])'),
 ('resubmit lookup (parent_submission_id)', 'SELECT id FROM public.transaction_submissions WHERE parent_submission_id = ''{s_sub}'''),
 ('submission_messages',              'SELECT * FROM public.submission_messages'),
 ('submission_attachments',           'SELECT * FROM public.submission_attachments'),
 ('submission_comments',              'SELECT * FROM public.submission_comments'),
 ('storage.objects in submission-attachments', 'SELECT * FROM storage.objects WHERE bucket_id = ''submission-attachments'''),
 ('UPDATE transaction_submissions',   'UPDATE public.transaction_submissions SET property_address = ''x'' WHERE id = ''{s_sub}'''),
 ('UPDATE uploading submission',      'UPDATE public.transaction_submissions SET property_address = ''x'' WHERE id = ''{s_upl}'''),
 ('DELETE uploading submission',      'DELETE FROM public.transaction_submissions WHERE id = ''{s_upl}''')
) AS t(label, q);
-- A signed-in token with no subject behaves the same.
SELECT pg_temp.expect('c2 authenticated without uid ' || label, 'authenticated', NULL, q, 'OK rows=0') FROM (VALUES
 ('transaction_submissions', 'SELECT * FROM public.transaction_submissions'),
 ('submission_messages',     'SELECT * FROM public.submission_messages'),
 ('submission_attachments',  'SELECT * FROM public.submission_attachments')
) AS t(label, q);
