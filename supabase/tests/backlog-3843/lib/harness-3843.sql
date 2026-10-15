-- BACKLOG-3843 harness additions. Loaded after the 3679 and 3538 helpers,
-- inside the same rolled-back transaction, as postgres.

-- Extra fixture names (ids are md5-derived; see ../backlog-3679/lib/harness.sql).
CREATE OR REPLACE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_a','u_b','u_c','u_d','u_e','org1','org2','org_pa',
                      'inv_a','inv_d','inv_exp','m_admin1','m_member','m_admin2','m_pa','org_pb','m_pb','m_c_o2',
                      'm_claimed',
                      'u_f','u_g','u_h','m_f','m_g','inv_susp','org_jit','role_3843']) $f$;

CREATE FUNCTION pg_temp.uf() RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.id('u_f') $$;
CREATE FUNCTION pg_temp.ug() RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.id('u_g') $$;
CREATE FUNCTION pg_temp.uh() RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.id('u_h') $$;

-- Organization row as text (as postgres), for unchanged-after checks.
CREATE FUNCTION pg_temp.osnap(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT (to_jsonb(o) - 'updated_at')::text FROM public.organizations o WHERE o.id = p_id $f$;

-- Catalogue fingerprint for every object 3843 touches: the 3538 fingerprint
-- (members policies/triggers, guard definition + ACL) plus organizations'
-- triggers and policies and the new guard function.
CREATE FUNCTION pg_temp.fp3843() RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.fp3538() || ' ' || md5(concat_ws(E'\n',
    coalesce((SELECT string_agg(pg_get_triggerdef(oid) || tgenabled::text, E'\n' ORDER BY tgname)
              FROM pg_trigger WHERE tgrelid='public.organizations'::regclass AND NOT tgisinternal), ''),
    coalesce((SELECT string_agg(concat_ws('|', policyname, cmd, roles::text, permissive, qual, with_check), E'\n' ORDER BY policyname)
              FROM pg_policies WHERE schemaname='public' AND tablename='organizations'), ''),
    pg_temp.fn_fp('public.guard_organization_client_update()')))
$f$;

-- A refusal raised by one of the 3843 guards (SQLSTATE 42501 and the guard's own message).
CREATE FUNCTION pg_temp.org_refused(m text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT m LIKE 'ERR 42501 This organization setting cannot be changed from a client session%' $f$;
CREATE FUNCTION pg_temp.is42501(m text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT m LIKE 'ERR 42501 %' $f$;
