-- C30 (BACKLOG-3474, A2): a save that changes ONLY items still moves the
-- template's updated_at, so a second editor holding the old token is refused.
--   items-only save with token0            -> ok, new token <> token0
--   another save with token0               -> P0001 stale_or_not_found
-- Mutants: m59 (template UPDATE skipped when name and description are unchanged),
-- m57 (stale predicate dropped).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c30 template', 2)::text, true) IS NOT NULL;

DO $c30$
DECLARE
  tpl   uuid := current_setting('t3474.tpl')::uuid;
  items jsonb := pg_temp.t3474_items(current_setting('t3474.tpl')::uuid);
  res   text;
BEGIN
  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'),
           'c30 template', NULL, jsonb_build_array(items->1, items->0));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C30 items-only save ok, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_token(tpl) <> current_setting('t3474.token0'), 'C30 items-only save moved updated_at');
  PERFORM pg_temp.check(pg_temp.t3474_tok(res) = pg_temp.t3474_token(tpl), 'C30 returned token = stored');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_admin'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'),
           'c30 template', NULL, items);
  PERFORM pg_temp.check(res = 'P0001:stale_or_not_found', format('C30 old token refused after an items-only save, got %s', res));
END
$c30$;
