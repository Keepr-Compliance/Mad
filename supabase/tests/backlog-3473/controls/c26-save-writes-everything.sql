-- C26 (BACKLOG-3474): one save writes the name, the description and the whole
-- item list -- reorder, edit, add, remove -- for each editor role.
--   broker: reverse + edit + add + remove  -> ok; exact shape; sort 10/20/30
--   name and titles stored trimmed; blank description stored NULL
--   returned token = the row's updated_at as PostgREST serialises it
--   admin, then it_admin, save again with the returned token -> ok
-- Mutants: none dedicated; every mutant runs it under MATRIX=1.

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c26 template', 3)::text, true) IS NOT NULL;

DO $c26$
DECLARE
  tpl  uuid := current_setting('t3474.tpl')::uuid;
  i1   jsonb := pg_temp.t3474_item(current_setting('t3474.tpl')::uuid, 1);
  i3   jsonb := pg_temp.t3474_item(current_setting('t3474.tpl')::uuid, 3);
  res  text;
  tok  text;
BEGIN
  PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = 'c26 template item 1:true:-:10|c26 template item 2:false:-:20|c26 template item 3:true:-:30',
                        'C26 starting shape');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'),
           '  c26 renamed  ', '   ',
           jsonb_build_array(
             i3,
             i1 || '{"title": "  c26 item one edited ", "expected_document_type": "contract", "description": "  kept  "}'::jsonb,
             '{"title": " c26 new item ", "is_required": false, "expected_document_type": ""}'::jsonb));
  PERFORM pg_temp.check(res LIKE 'ok:' || tpl || '|%', format('C26 broker save ok, got %s', res));
  tok := pg_temp.t3474_tok(res);
  PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = 'c26 template item 3:true:-:10|c26 item one edited:true:contract:20|c26 new item:false:-:30',
                        format('C26 items reordered/edited/added/removed, got %s', pg_temp.t3474_shape(tpl)));
  PERFORM pg_temp.check((SELECT count(*) FROM public.checklist_template_items WHERE template_id = tpl) = 3, 'C26 item 2 removed');
  PERFORM pg_temp.check((SELECT description FROM public.checklist_template_items WHERE id = (i1->>'id')::uuid) = 'kept',
                        'C26 item description stored trimmed');
  PERFORM pg_temp.check((SELECT name || '/' || coalesce(description, '<null>') FROM public.checklist_templates WHERE id = tpl) = 'c26 renamed/<null>',
                        'C26 name trimmed, blank description NULL');
  PERFORM pg_temp.check(tok = pg_temp.t3474_token(tpl), format('C26 returned token %s = stored %s', tok, pg_temp.t3474_token(tpl)));
  PERFORM pg_temp.check(tok <> current_setting('t3474.token0'), 'C26 token moved');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_admin'), pg_temp.id('o_t1'), tpl, tok, 'c26 by admin', NULL,
           pg_temp.t3474_items(tpl));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C26 admin save ok, got %s', res));
  res := pg_temp.t3474_save(pg_temp.id('u_t1_itadmin'), pg_temp.id('o_t1'), tpl, pg_temp.t3474_tok(res), 'c26 by it_admin', 'd',
           pg_temp.t3474_items(tpl));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C26 it_admin save ok, got %s', res));
  PERFORM pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = tpl) = 'c26 by it_admin', 'C26 it_admin name stored');
END
$c26$;
