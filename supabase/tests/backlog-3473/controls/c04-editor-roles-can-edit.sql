-- C4: broker, admin and it_admin of an entitled organization EACH can write
-- templates and items. For each of u_t1_broker, u_t1_admin, u_t1_itadmin:
--   INSERT a T1 template                         : rows:1
--   UPDATE T1's seeded template B                : rows:1
--   INSERT an item into template B               : rows:1
--   UPDATE T1's item A1                          : rows:1
--   DELETE the item it inserted                  : rows:1
-- Mutants: m06a (no broker), m06b (no admin), m06c (no it_admin) -- each reds
-- that role's cases.

DO $roles$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('broker', pg_temp.id('u_t1_broker')),
                                 ('admin', pg_temp.id('u_t1_admin')),
                                 ('it_admin', pg_temp.id('u_t1_itadmin'))) v(role, uid) LOOP
    PERFORM pg_temp.act_as(r.uid);
    PERFORM pg_temp.expect('C4 ' || r.role || ' INSERT template',
      format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'c04 ' || r.role), 'rows:1');
    PERFORM pg_temp.expect('C4 ' || r.role || ' UPDATE template',
      format('UPDATE public.checklist_templates SET name = %L WHERE id = %L', 'c04 ' || r.role, pg_temp.id('tpl_t1_b')), 'rows:1');
    PERFORM pg_temp.expect('C4 ' || r.role || ' INSERT item',
      format('INSERT INTO public.checklist_template_items (template_id, title, is_required, expected_document_type) VALUES (%L, %L, true, %L)',
             pg_temp.id('tpl_t1_b'), 'c04 ' || r.role, 'closing'), 'rows:1');
    PERFORM pg_temp.expect('C4 ' || r.role || ' UPDATE item',
      format('UPDATE public.checklist_template_items SET title = %L WHERE id = %L', 'c04 ' || r.role, pg_temp.id('item_t1_a1')), 'rows:1');
    PERFORM pg_temp.expect('C4 ' || r.role || ' DELETE item',
      format('DELETE FROM public.checklist_template_items WHERE template_id = %L AND title = %L', pg_temp.id('tpl_t1_b'), 'c04 ' || r.role), 'rows:1');
    PERFORM pg_temp.act_owner();
  END LOOP;
END
$roles$;
