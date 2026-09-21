-- C9: copy rows are inserted only by the submitter, only while the submission
-- is 'uploading'. Each case leaves exactly one term to refuse.
--   submitter: header on S_sub (submitted, no header yet)            : RLS
--       (no header exists, so UNIQUE cannot refuse; T1 is entitled)
--   T1 broker: header on S_up (uploading, no header yet)             : RLS
--       (the broker CAN read S_up through transaction_submissions' own
--       SELECT policy, S_up is uploading and T1 is entitled -- so only the
--       submitter term refuses; m12 turns this red)
--   second T1 agent: header on S_up                                  : RLS
--       (NOT a one-term case: an agent cannot read S_up in
--       transaction_submissions at all, so the EXISTS is false whatever the
--       copy policy says -- measured in phase ii, m12 left it green. Kept as
--       an outcome assertion, not as m12's discriminator.)
--   submitter: item under S_fin's header (S_fin submitted)           : RLS
--   submitter: link under S_fin's item                               : RLS
--   submitter: member A5 under S_fin's attachment link (B.1: A5 is S_fin's own,
--       unlinked, so neither UNIQUE nor the same-submission term refuses) : RLS
-- Mutants: m11 (header without the status term), m12 (header without the
-- submitter term), m13a/b/c (item / link / member without the status term).

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C9 header on a submitted submission',
  format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', pg_temp.id('s_sub'), 'c09'), 'RLS');

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.check(pg_temp.n(format('SELECT count(*) FROM public.transaction_submissions WHERE id = %L AND status = %L',
                                      pg_temp.id('s_up'), 'uploading')) = 1,
                     'C9 precondition: the T1 broker reads S_up, uploading, in transaction_submissions');
SELECT pg_temp.expect('C9 header by a T1 broker who can read the submission',
  format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', pg_temp.id('s_up'), 'c09'), 'RLS');

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent2'));
SELECT pg_temp.expect('C9 header by someone other than the submitter',
  format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', pg_temp.id('s_up'), 'c09'), 'RLS');

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C9 item on a submitted submission',
  format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required) VALUES (%L, %L, %L, false)',
         pg_temp.id('s_fin'), pg_temp.id('h_fin'), 'c09'), 'RLS');
SELECT pg_temp.expect('C9 link on a submitted submission',
  format('INSERT INTO public.submission_checklist_links (submission_id, submission_checklist_item_id, kind, label) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_fin'), pg_temp.id('i_fin'), 'attachment', 'c09'), 'RLS');
SELECT pg_temp.expect('C9 member on a submitted submission',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_fin'), pg_temp.id('l_fin_a'), 'attachment', pg_temp.id('a5')), 'RLS');
SELECT pg_temp.act_owner();

DO $post$
BEGIN
  PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM public.submission_checklists WHERE submission_id IN (%L, %L)',
                                         pg_temp.id('s_sub'), pg_temp.id('s_up'))) = 0,
                        'no header on S_sub or S_up');
END
$post$;
