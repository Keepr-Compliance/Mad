-- C12b (Addendum B R4): a member's kind must equal its link's kind.
-- Setup as the owner on S_up: header, item, email link.
-- As u_t1_agent: an `attachment` member -> A1 (S_up's own) under the EMAIL
-- link                                                                 : FK
--   The CHECK passes (attachment kind, attachment id, no message id) and RLS
--   passes; only FK (link_id, submission_id, kind) refuses.
-- Mutant: m21 (the members FK without kind).

SELECT pg_temp.act_owner();
INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES
  ('00000000-0000-4000-8000-00003473e401', pg_temp.id('s_up'), 'Fixture starter A'); -- pii-allow-uuid: invented fixture id
INSERT INTO public.submission_checklist_items (id, submission_id, submission_checklist_id, title, is_required) VALUES
  ('00000000-0000-4000-8000-00003473e402', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e401', 'Fixture item A1', true); -- pii-allow-uuid: invented fixture ids
INSERT INTO public.submission_checklist_links (id, submission_id, submission_checklist_item_id, kind, label) VALUES
  ('00000000-0000-4000-8000-00003473e404', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e402', 'email', 'Fixture thread'); -- pii-allow-uuid: invented fixture ids

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C12b attachment member under an email link',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e404', 'attachment', pg_temp.id('a1')), 'FK'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.act_owner();
