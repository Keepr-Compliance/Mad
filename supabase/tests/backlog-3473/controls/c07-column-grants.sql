-- C7 (Addendum B R4): clients cannot set seed_key, seeded_at, created_by or
-- organization_id. Every case below passes RLS and every CHECK, FK and UNIQUE,
-- so only the column grant can refuse.
--   T1 broker UPDATE seeded template A: seed_key zz_test_a -> zz_test_c       : PRIV
--       (seeded_at stays non-null, so the pair CHECK holds; (T1, zz_test_c) is free)
--   T1 broker UPDATE template A: created_by -> u_t1_admin (a valid user)      : PRIV
--   T1 broker INSERT with seed_key 'zz_forged', seeded_at now()                : PRIV
--   u_y (broker in T1 AND E) INSERT an unseeded T1 template                   : rows:1
--   u_y UPDATE that template: organization_id T1 -> E                         : PRIV
--       (USING can_edit(T1) and WITH CHECK can_edit(E) both pass; seed_key NULL)
--   T1 broker UPDATE template A: name = name                                  : rows:1
--       <- the same caller reaches the row, so the PRIVs above are the grant
-- Mutants: m09a (UPDATE on the whole table), m09b (INSERT on the whole table).

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C7 seed_key change',
  format('UPDATE public.checklist_templates SET seed_key = %L WHERE id = %L', 'zz_test_c', pg_temp.id('tpl_t1_a')), 'PRIV');
SELECT pg_temp.expect('C7 created_by change',
  format('UPDATE public.checklist_templates SET created_by = %L WHERE id = %L', pg_temp.id('u_t1_admin'), pg_temp.id('tpl_t1_a')), 'PRIV');
SELECT pg_temp.expect('C7 forged seeded insert',
  format('INSERT INTO public.checklist_templates (organization_id, name, seed_key, seeded_at) VALUES (%L, %L, %L, now())',
         pg_temp.id('o_t1'), 'c07 forged', 'zz_forged'), 'PRIV');
SELECT pg_temp.expect('C7 name update reaches the row',
  format('UPDATE public.checklist_templates SET name = name WHERE id = %L', pg_temp.id('tpl_t1_a')), 'rows:1');

SELECT pg_temp.act_as(pg_temp.id('u_y'));
SELECT pg_temp.expect('C7 u_y creates an unseeded T1 template',
  format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'c07 movable'), 'rows:1');
SELECT pg_temp.expect('C7 organization move T1 -> E',
  format('UPDATE public.checklist_templates SET organization_id = %L WHERE organization_id = %L AND name = %L',
         pg_temp.id('o_e'), pg_temp.id('o_t1'), 'c07 movable'), 'PRIV');

SELECT pg_temp.act_owner();
DO $post$
BEGIN
  PERFORM pg_temp.check((SELECT seed_key || '/' || coalesce(created_by::text, 'null') FROM public.checklist_templates
                          WHERE id = pg_temp.id('tpl_t1_a')) = 'zz_test_a/null',
                        'template A keeps seed_key zz_test_a and a NULL created_by');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE seed_key = 'zz_forged'),
                        'no forged seeded row');
  PERFORM pg_temp.check((SELECT organization_id FROM public.checklist_templates WHERE name = 'c07 movable') = pg_temp.id('o_t1'),
                        'the movable template is still in T1');
END
$post$;
