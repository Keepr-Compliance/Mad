-- C37 (BACKLOG-3474 PR 3): the last editor is the user whose save last moved
-- updated_at, including a save that only reorders items.
--   owner-created template (no signed-in user)               -> updated_by NULL
--   broker: order-only save                                  -> updated_by = broker, updated_at moved
--   admin: name-only save with the new token                 -> updated_by = admin
--   broker: create through save_checklist_template           -> created_by = broker, updated_by NULL
-- Mutants: m65 (updated_by never set), m67 (trigger fires only on archived_at).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c37 template', 2)::text, true) IS NOT NULL;

DO $c37$
DECLARE
  tpl   uuid := current_setting('t3474.tpl')::uuid;
  items jsonb := pg_temp.t3474_items(current_setting('t3474.tpl')::uuid);
  res   text;
  newid uuid;
BEGIN
  PERFORM pg_temp.check((SELECT updated_by FROM public.checklist_templates WHERE id = tpl) IS NULL,
                        'C37 a new template has no last editor');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'),
           'c37 template', NULL, jsonb_build_array(items->1, items->0));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C37 order-only save ok, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_token(tpl) <> current_setting('t3474.token0'), 'C37 order-only save moved updated_at');
  PERFORM pg_temp.check((SELECT updated_by FROM public.checklist_templates WHERE id = tpl) = pg_temp.id('u_t1_broker'),
                        format('C37 order-only save records the broker, got %s',
                               (SELECT coalesce(updated_by::text, 'NULL') FROM public.checklist_templates WHERE id = tpl)));

  res := pg_temp.t3474_save(pg_temp.id('u_t1_admin'), pg_temp.id('o_t1'), tpl, pg_temp.t3474_tok(res),
           'c37 template renamed', NULL, pg_temp.t3474_items(tpl));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C37 admin save ok, got %s', res));
  PERFORM pg_temp.check((SELECT updated_by FROM public.checklist_templates WHERE id = tpl) = pg_temp.id('u_t1_admin'),
                        'C37 the next save replaces the last editor');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), NULL, NULL,
           'c37 created', NULL, '[{"title":"first"}]'::jsonb);
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C37 create ok, got %s', res));
  newid := split_part(substr(res, 4), '|', 1)::uuid;
  PERFORM pg_temp.check((SELECT created_by = pg_temp.id('u_t1_broker') AND updated_by IS NULL
                           FROM public.checklist_templates WHERE id = newid),
                        'C37 create: created_by = caller, no last editor');
END
$c37$;
