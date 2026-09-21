-- C11: a member cannot point at another submission's attachment or message,
-- even one the same agent submitted. (The target FKs are single-column and
-- bypass RLS, so the policy's same-submission terms are the only guard.)
-- Setup, as the owner, on S_up: header, item, an attachment link and an email
-- link -- so only the members INSERT policy is under test.
-- As u_t1_agent (submitter of both S_up and S_sub):
--   attachment member on S_up's link -> A3 (S_sub's)     : RLS
--   email member on S_up's link -> M4 (S_sub's, email)   : RLS
--   attachment member -> A1 (S_up's own)                 : rows:1  <- rest of the guard passes
--   email member -> M1 (S_up's own, email)               : rows:1
-- Mutants: m18a (attachment same-submission term dropped),
--          m18b (message same-submission term dropped).

SELECT pg_temp.act_owner();
INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES
  ('00000000-0000-4000-8000-00003473e401', pg_temp.id('s_up'), 'Fixture starter A'); -- pii-allow-uuid: invented fixture id
INSERT INTO public.submission_checklist_items (id, submission_id, submission_checklist_id, title, is_required) VALUES
  ('00000000-0000-4000-8000-00003473e402', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e401', 'Fixture item A1', true); -- pii-allow-uuid: invented fixture ids
INSERT INTO public.submission_checklist_links (id, submission_id, submission_checklist_item_id, kind, label) VALUES
  ('00000000-0000-4000-8000-00003473e403', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e402', 'attachment', 'fixture-a1.pdf'), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e404', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e402', 'email', 'Fixture thread'); -- pii-allow-uuid: invented fixture ids

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C11 attachment member -> another submission''s attachment',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e403', 'attachment', pg_temp.id('a3')), 'RLS'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.expect('C11 email member -> another submission''s message',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_message_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e404', 'email', pg_temp.id('m4')), 'RLS'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.expect('C11 attachment member -> own attachment',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e403', 'attachment', pg_temp.id('a1')), 'rows:1'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.expect('C11 email member -> own email',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_message_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e404', 'email', pg_temp.id('m1')), 'rows:1'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.act_owner();
