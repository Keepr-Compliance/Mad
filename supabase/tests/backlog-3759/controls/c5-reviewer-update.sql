-- C5: a reviewer's decision passes the status_history guard trigger, which
-- calls can_review_submission as the caller (invoker).
SELECT pg_temp.expect('c5 broker moves a submission to under_review, naming itself', 'authenticated', pg_temp.id('u_broker'),
  'UPDATE public.transaction_submissions SET status = ''under_review'', reviewed_by = ''{u_broker}'', reviewed_at = now() WHERE id = ''{s_sub}''', 'OK rows=1');
SELECT pg_temp.expect('c5 outsider cannot write review fields', 'authenticated', pg_temp.id('u_outsider'),
  'UPDATE public.transaction_submissions SET status = ''under_review'', reviewed_by = ''{u_outsider}'', reviewed_at = now() WHERE id = ''{s_sub}''', 'OK rows=0');
