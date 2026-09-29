-- C14: the agent deleting its own uploading submission removes every copy row
-- (the stale-upload and failed-submission cleanups delete the parent).
-- Setup as the owner on S_up: header, item, attachment link + member A1,
-- email link + member M1.
--   u_t1_agent DELETE S_up                       : rows:1
--   owner: S_up, and every copy row of S_up      : gone
-- Mutant: m23 (header FK -> ON DELETE NO ACTION -> the delete raises FK).

SELECT pg_temp.act_owner();
INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES
  ('00000000-0000-4000-8000-00003473e401', pg_temp.id('s_up'), 'Fixture starter A'); -- pii-allow-uuid: invented fixture id
INSERT INTO public.submission_checklist_items (id, submission_id, submission_checklist_id, title, is_required) VALUES
  ('00000000-0000-4000-8000-00003473e402', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e401', 'Fixture item A1', true); -- pii-allow-uuid: invented fixture ids
INSERT INTO public.submission_checklist_links (id, submission_id, submission_checklist_item_id, kind, label) VALUES
  ('00000000-0000-4000-8000-00003473e403', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e402', 'attachment', 'fixture-a1.pdf'), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e404', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e402', 'email', 'Fixture thread'); -- pii-allow-uuid: invented fixture ids
INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id, submission_message_id) VALUES
  (pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e403', 'attachment', pg_temp.id('a1'), NULL), -- pii-allow-uuid: invented fixture id
  (pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e404', 'email', NULL, pg_temp.id('m1')); -- pii-allow-uuid: invented fixture id

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C14 agent deletes its uploading submission',
  format('DELETE FROM public.transaction_submissions WHERE id = %L', pg_temp.id('s_up')), 'rows:1');
SELECT pg_temp.act_owner();

DO $post$
DECLARE
  t text;
BEGIN
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.transaction_submissions WHERE id = pg_temp.id('s_up')),
                        'S_up is gone');
  FOREACH t IN ARRAY ARRAY['public.submission_checklists', 'public.submission_checklist_items',
                           'public.submission_checklist_links', 'public.submission_checklist_link_members'] LOOP
    PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM %s WHERE submission_id = %L', t, pg_temp.id('s_up'))) = 0,
                          'no ' || t || ' row of S_up remains');
  END LOOP;
END
$post$;
