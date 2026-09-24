-- C32 (BACKLOG-3474, A5 + foreign ids): every id in the payload must be an
-- item of THIS template, once.
--   the same id twice                          -> P0001 item_mismatch
--   an item of another template, same org      -> item_mismatch; that item untouched
--   an item of another organization's template -> item_mismatch
--   an id that exists nowhere                  -> item_mismatch
-- Each time nothing changes.
-- Mutants: m61 (UPDATE loses `template_id = v_template_id`), m62 (count taken
-- over DISTINCT ids instead of elements).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c32 template', 2)::text, true) IS NOT NULL;

DO $c32$
DECLARE
  tpl    uuid := current_setting('t3474.tpl')::uuid;
  i1     jsonb := pg_temp.t3474_item(current_setting('t3474.tpl')::uuid, 1);
  i2     jsonb := pg_temp.t3474_item(current_setting('t3474.tpl')::uuid, 2);
  shape0 text := pg_temp.t3474_shape(current_setting('t3474.tpl')::uuid);
  head0  text := pg_temp.t3474_head(current_setting('t3474.tpl')::uuid);
  e_item uuid := (SELECT i.id FROM public.checklist_template_items i WHERE i.template_id = pg_temp.id('tpl_e_a') ORDER BY i.sort_order LIMIT 1);
  label  text;
  bad    jsonb;
  res    text;
BEGIN
  PERFORM pg_temp.check(e_item IS NOT NULL, 'C32 fixtures give E a seeded item');
  FOR label, bad IN SELECT * FROM (VALUES
      ('duplicate id',            i1 || '{"title": "c32 duplicate"}'::jsonb),
      ('same-org foreign item',   jsonb_build_object('id', pg_temp.id('item_t1_a1'), 'title', 'c32 stolen')),
      ('other-org foreign item',  jsonb_build_object('id', e_item, 'title', 'c32 stolen')),
      ('unknown id',              '{"id": "00000000-0000-4000-8000-000034749999", "title": "c32 ghost"}'::jsonb) -- pii-allow-uuid: invented fixture id
    ) v(l, b) LOOP
    res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'),
             'c32 changed', NULL, jsonb_build_array(i1, i2, bad));
    PERFORM pg_temp.check(res = 'P0001:item_mismatch', format('C32 %s refused, got %s', label, res));
    PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = shape0 AND pg_temp.t3474_head(tpl) = head0, format('C32 %s changed nothing', label));
  END LOOP;
  PERFORM pg_temp.check((SELECT title FROM public.checklist_template_items WHERE id = pg_temp.id('item_t1_a1')) = 'Fixture item A1',
                        'C32 same-org foreign item untouched');
  PERFORM pg_temp.check((SELECT title FROM public.checklist_template_items WHERE id = e_item) <> 'c32 stolen',
                        'C32 other-org item untouched');
END
$c32$;
