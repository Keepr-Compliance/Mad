-- C11c (Should-fix 1, decision 18edc9b5): texts are not link targets in v1.
-- Setup as the owner on S_up: header, item, email link.
-- As u_t1_agent:
--   email member -> M3 (S_up's own, channel sms)     : RLS
--   email member -> M2 (S_up's own, channel email)   : rows:1  <- the rest passes
-- Mutant: m19 (channel term dropped).

SELECT pg_temp.act_owner();
INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES
  ('00000000-0000-4000-8000-00003473e401', pg_temp.id('s_up'), 'Fixture starter A'); -- pii-allow-uuid: invented fixture id
INSERT INTO public.submission_checklist_items (id, submission_id, submission_checklist_id, title, is_required) VALUES
  ('00000000-0000-4000-8000-00003473e402', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e401', 'Fixture item A1', true); -- pii-allow-uuid: invented fixture ids
INSERT INTO public.submission_checklist_links (id, submission_id, submission_checklist_item_id, kind, label) VALUES
  ('00000000-0000-4000-8000-00003473e404', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e402', 'email', 'Fixture thread'); -- pii-allow-uuid: invented fixture ids

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C11c email member -> an sms message',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_message_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e404', 'email', pg_temp.id('m3')), 'RLS'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.expect('C11c email member -> an email message',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_message_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e404', 'email', pg_temp.id('m2')), 'rows:1'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.act_owner();
