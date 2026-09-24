-- C33 (BACKLOG-3474, A6): the item list is enforced in SQL, not only in the
-- portal. 0 and 201 items, a non-array, an array holding a non-object and NULL
-- -> 22023 invalid_items, nothing changed. 1 and 200 items -> ok.
-- Mutant: m63 (the 1..200 bound removed from the function).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c33 template', 2)::text, true) IS NOT NULL;

DO $c33$
DECLARE
  tpl    uuid := current_setting('t3474.tpl')::uuid;
  shape0 text := pg_temp.t3474_shape(current_setting('t3474.tpl')::uuid);
  head0  text := pg_temp.t3474_head(current_setting('t3474.tpl')::uuid);
  n201   jsonb := (SELECT jsonb_agg(jsonb_build_object('title', 'c33 item ' || g)) FROM generate_series(1, 201) g);
  n200   jsonb := (SELECT jsonb_agg(jsonb_build_object('title', 'c33 item ' || g)) FROM generate_series(1, 200) g);
  label  text;
  bad    jsonb;
  res    text;
BEGIN
  FOR label, bad IN SELECT * FROM (VALUES
      ('0 items', '[]'::jsonb), ('201 items', n201), ('an object', '{"title": "x"}'::jsonb),
      ('a non-object element', '["x"]'::jsonb), ('NULL', NULL::jsonb)) v(l, b) LOOP
    res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'), 'c33 changed', NULL, bad);
    PERFORM pg_temp.check(res = '22023:invalid_items', format('C33 %s refused, got %s', label, res));
    PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = shape0 AND pg_temp.t3474_head(tpl) = head0, format('C33 %s changed nothing', label));
  END LOOP;

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'), 'c33 one', NULL,
           '[{"title": "c33 only"}]'::jsonb);
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C33 1 item ok, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = 'c33 only:false:-:10', 'C33 1 item stored');
  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, pg_temp.t3474_tok(res), 'c33 many', NULL, n200);
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C33 200 items ok, got %s', res));
  PERFORM pg_temp.check((SELECT count(DISTINCT sort_order) FROM public.checklist_template_items WHERE template_id = tpl) = 200,
                        'C33 200 items, 200 distinct sort_order values');
END
$c33$;
