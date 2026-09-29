-- C31 (BACKLOG-3474, A3): the token a save returns is the one the next save
-- needs. save(token0) -> ok tokA; save(tokA) -> ok tokB; tokB = stored.
-- Mutant: m60 (the function returns the caller's token instead of the new one).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c31 template', 2)::text, true) IS NOT NULL;

DO $c31$
DECLARE
  tpl   uuid := current_setting('t3474.tpl')::uuid;
  res   text;
BEGIN
  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'),
           'c31 first', NULL, pg_temp.t3474_items(tpl));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C31 first save ok, got %s', res));
  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, pg_temp.t3474_tok(res),
           'c31 second', NULL, pg_temp.t3474_items(tpl));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C31 second save with the returned token ok, got %s', res));
  PERFORM pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = tpl) = 'c31 second', 'C31 second save stored');
  PERFORM pg_temp.check(pg_temp.t3474_tok(res) = pg_temp.t3474_token(tpl), 'C31 returned token = stored');
END
$c31$;
