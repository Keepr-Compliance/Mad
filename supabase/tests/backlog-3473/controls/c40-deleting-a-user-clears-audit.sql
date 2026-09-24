-- C40 (BACKLOG-3474 PR 3, SR B1): deleting a user honours the foreign keys'
-- ON DELETE SET NULL on archived_by and updated_by; the trigger must not write
-- the deleted id back (which fails the FK check with 23503).
--   admin archives template A, then admin is deleted  -> rows:1; A: archived_by NULL, still archived
--   broker saves template B, then broker is deleted   -> rows:1; B: updated_by NULL
-- Mutant: m70 (archived_by written back from OLD while archived).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl_a', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c40 archived', 1)::text, true) IS NOT NULL;
SELECT set_config('t3474.tpl_b', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c40 edited', 1)::text, true) IS NOT NULL;

SELECT pg_temp.act_as(pg_temp.id('u_t1_admin'));
SELECT pg_temp.expect('C40 admin archives A',
  format('UPDATE public.checklist_templates SET archived_at = now() WHERE id = %L AND archived_at IS NULL', current_setting('t3474.tpl_a')), 'rows:1');
SELECT pg_temp.act_owner();

DO $c40$
DECLARE
  b   uuid := current_setting('t3474.tpl_b')::uuid;
  res text;
BEGIN
  PERFORM pg_temp.check((SELECT archived_by FROM public.checklist_templates WHERE id = current_setting('t3474.tpl_a')::uuid) = pg_temp.id('u_t1_admin'),
                        'C40 precondition: A archived by the admin');
  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), b, current_setting('t3474.token0'),
           'c40 edited renamed', NULL, pg_temp.t3474_items(b));
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C40 broker save of B ok, got %s', res));
  PERFORM pg_temp.check((SELECT updated_by FROM public.checklist_templates WHERE id = b) = pg_temp.id('u_t1_broker'),
                        'C40 precondition: B last edited by the broker');
END
$c40$;

SELECT pg_temp.expect('C40 delete the archiver',
  format('DELETE FROM auth.users WHERE id = %L', pg_temp.id('u_t1_admin')), 'rows:1');
SELECT pg_temp.check((SELECT archived_by IS NULL AND archived_at IS NOT NULL FROM public.checklist_templates
                       WHERE id = current_setting('t3474.tpl_a')::uuid),
                     'C40 A: archived_by NULL, still archived');

SELECT pg_temp.expect('C40 delete the last editor',
  format('DELETE FROM auth.users WHERE id = %L', pg_temp.id('u_t1_broker')), 'rows:1');
SELECT pg_temp.check((SELECT updated_by IS NULL FROM public.checklist_templates
                       WHERE id = current_setting('t3474.tpl_b')::uuid),
                     'C40 B: updated_by NULL');
