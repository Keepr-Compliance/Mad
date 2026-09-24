-- C38 (BACKLOG-3474 PR 3): archived_by follows archived_at, through the
-- portal's own archive / restore request (a PostgREST UPDATE of archived_at).
--   admin archives                                  -> archived_by = admin, updated_by = admin
--   broker saves the archived template (name only)  -> archived_by still admin, updated_by = broker
--   broker restores                                 -> archived_at NULL AND archived_by NULL, updated_by = broker
--   broker archives again                           -> archived_by = broker
-- Mutants: m66 (restore keeps archived_by), m68 (archived_by recomputed on every
-- update while archived), m67 (trigger fires only on archived_at).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c38 template', 1)::text, true) IS NOT NULL;

CREATE FUNCTION pg_temp.c38_row(p_tpl uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT (archived_at IS NOT NULL)::text || '|' || coalesce(archived_by::text, 'NULL') || '|' || coalesce(updated_by::text, 'NULL')
    FROM public.checklist_templates WHERE id = p_tpl
$$;

SELECT pg_temp.act_as(pg_temp.id('u_t1_admin'));
SELECT pg_temp.expect('C38 admin archives',
  format('UPDATE public.checklist_templates SET archived_at = now() WHERE id = %L AND archived_at IS NULL', current_setting('t3474.tpl')), 'rows:1');
SELECT pg_temp.act_owner();

DO $c38$
DECLARE
  tpl uuid := current_setting('t3474.tpl')::uuid;
  res text;
  adm text := pg_temp.id('u_t1_admin')::text;
  brk text := pg_temp.id('u_t1_broker')::text;
BEGIN
  PERFORM pg_temp.check(pg_temp.c38_row(tpl) = 'true|' || adm || '|' || adm,
                        format('C38 archive records the admin, got %s', pg_temp.c38_row(tpl)));

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, pg_temp.t3474_token(tpl),
           'c38 template renamed', NULL, pg_temp.t3474_items(tpl));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C38 save of an archived template ok, got %s', res));
  PERFORM pg_temp.check(pg_temp.c38_row(tpl) = 'true|' || adm || '|' || brk,
                        format('C38 a save while archived keeps the archiver, got %s', pg_temp.c38_row(tpl)));
END
$c38$;

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C38 broker restores',
  format('UPDATE public.checklist_templates SET archived_at = NULL WHERE id = %L AND archived_at IS NOT NULL', current_setting('t3474.tpl')), 'rows:1');
SELECT pg_temp.act_owner();
SELECT pg_temp.check(pg_temp.c38_row(current_setting('t3474.tpl')::uuid) = 'false|NULL|' || pg_temp.id('u_t1_broker'),
                     format('C38 restore clears archived_by, got %s', pg_temp.c38_row(current_setting('t3474.tpl')::uuid)));

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C38 broker archives again',
  format('UPDATE public.checklist_templates SET archived_at = now() WHERE id = %L AND archived_at IS NULL', current_setting('t3474.tpl')), 'rows:1');
SELECT pg_temp.act_owner();
SELECT pg_temp.check(pg_temp.c38_row(current_setting('t3474.tpl')::uuid) = 'true|' || pg_temp.id('u_t1_broker') || '|' || pg_temp.id('u_t1_broker'),
                     format('C38 a second archive records its own archiver, got %s', pg_temp.c38_row(current_setting('t3474.tpl')::uuid)));
