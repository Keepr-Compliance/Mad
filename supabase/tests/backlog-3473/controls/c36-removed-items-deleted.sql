-- C36 (BACKLOG-3474): items missing from the payload are deleted, also when the
-- payload holds a NEW item (an element with no id, whose NULL id would make a
-- naive `id <> ALL(...)` delete nothing).
--   3 items; payload [item 1, new]  -> items 2 and 3 gone, 2 items remain
--   payload [new only]              -> every old item gone
-- Mutant: m64 (kept ids built from every element, NULLs included).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c36 template', 3)::text, true) IS NOT NULL;

DO $c36$
DECLARE
  tpl uuid := current_setting('t3474.tpl')::uuid;
  res text;
BEGIN
  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'), 'c36 template', NULL,
           jsonb_build_array(pg_temp.t3474_item(tpl, 1), '{"title": "c36 new"}'::jsonb));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C36 save ok, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = 'c36 template item 1:true:-:10|c36 new:false:-:20',
                        format('C36 items 2 and 3 removed, got %s', pg_temp.t3474_shape(tpl)));

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, pg_temp.t3474_tok(res), 'c36 template', NULL,
           '[{"title": "c36 only new"}]'::jsonb);
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C36 second save ok, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = 'c36 only new:false:-:10', format('C36 all old items removed, got %s', pg_temp.t3474_shape(tpl)));
END
$c36$;
