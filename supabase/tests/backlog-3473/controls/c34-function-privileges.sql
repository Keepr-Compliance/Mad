-- C34 (BACKLOG-3474, A7 + catalog): who may execute save_checklist_template,
-- and how it runs.
--   anon EXECUTE false; authenticated EXECUTE true; no PUBLIC grant
--   anon calling it -> 42501 permission denied for function
--   SECURITY INVOKER (prosecdef false); search_path pinned to public
-- Mutants: m55 (file replayed with `anon` dropped from the REVOKE), m54 (SECURITY DEFINER).

SELECT pg_temp.act_owner();

DO $c34$
DECLARE
  sig text := 'public.save_checklist_template(uuid,uuid,text,text,text,jsonb)';
  p   record;
  res text;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = sig::regprocedure;
  PERFORM pg_temp.check(NOT has_function_privilege('anon', sig, 'EXECUTE'), 'C34 anon cannot execute');
  PERFORM pg_temp.check(has_function_privilege('authenticated', sig, 'EXECUTE'), 'C34 authenticated can execute');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), 'C34 no PUBLIC grant');
  PERFORM pg_temp.check(p.prosecdef IS FALSE, 'C34 SECURITY INVOKER');
  PERFORM pg_temp.check(p.proconfig = ARRAY['search_path=public'], format('C34 search_path pinned, got %s', p.proconfig));

  PERFORM pg_temp.act_anon();
  res := pg_temp.outcome(format('SELECT * FROM public.save_checklist_template(%L, NULL, NULL, %L, NULL, %L)',
                                pg_temp.id('o_t1'), 'c34 anon', '[{"title": "x"}]'));
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ~ '^42501:permission denied for function save_checklist_template', format('C34 anon call refused, got %s', res));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE name = 'c34 anon'), 'C34 anon wrote nothing');
END
$c34$;
