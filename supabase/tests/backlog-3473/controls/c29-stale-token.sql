-- C29 (BACKLOG-3474): the stale check compares updated_at at full precision.
--   token 1 microsecond LATER than stored         -> P0001 stale_or_not_found
--   token 1 microsecond EARLIER                   -> stale
--   token as a JS Date would print it (ms, 'Z')   -> stale
--   NULL token on an existing template            -> stale
--   same instant, other spelling ('... +00')      -> ok (value, not text)
-- Nothing changes on a stale call.
-- Mutants: m57 (stale predicate dropped), m58 (compared at millisecond precision).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c29 template', 2)::text, true) IS NOT NULL;

DO $c29$
DECLARE
  tpl    uuid := current_setting('t3474.tpl')::uuid;
  shape0 text := pg_temp.t3474_shape(current_setting('t3474.tpl')::uuid);
  head0  text := pg_temp.t3474_head(current_setting('t3474.tpl')::uuid);
  items  jsonb := pg_temp.t3474_items(current_setting('t3474.tpl')::uuid);
  tok    text;
  res    text;
BEGIN
  PERFORM pg_temp.check(pg_temp.t3474_token(tpl) = '2026-09-24T18:57:37.552806+00:00', 'C29 stored token is token0');
  FOREACH tok IN ARRAY ARRAY['2026-09-24T18:57:37.552807+00:00', '2026-09-24T18:57:37.552805+00:00',
                             '2026-09-24T18:57:37.552Z', NULL] LOOP
    res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, tok, 'c29 changed', NULL,
             jsonb_build_array(items->1, items->0));
    PERFORM pg_temp.check(res = 'P0001:stale_or_not_found', format('C29 token %s is stale, got %s', coalesce(tok, 'NULL'), res));
    PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = shape0 AND pg_temp.t3474_head(tpl) = head0,
                          format('C29 token %s changed nothing', coalesce(tok, 'NULL')));
  END LOOP;

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, '2026-09-24 18:57:37.552806+00', 'c29 changed', NULL,
           jsonb_build_array(items->1, items->0));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C29 same instant, other spelling saves, got %s', res));
END
$c29$;
