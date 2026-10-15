-- BACKLOG-3538 harness additions. Loaded after ../backlog-3679/lib/harness.sql,
-- inside the same rolled-back transaction, as postgres.

-- One extra fixture name: a claimed membership in O2 (see fixtures-3538.sql).
CREATE OR REPLACE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_a','u_b','u_c','u_d','u_e','org1','org2','org_pa',
                      'inv_a','inv_d','inv_exp','m_admin1','m_member','m_admin2','m_pa','org_pb','m_pb','m_c_o2',
                      'm_claimed']) $f$;

-- A function's ACL as sorted text, so the order entries come back in does not matter.
CREATE FUNCTION pg_temp.acl(p_fn regprocedure) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce((SELECT string_agg(a, ',' ORDER BY a) FROM unnest(pr.proacl::text[]) a), '<default>')
  FROM pg_proc pr WHERE pr.oid = p_fn $f$;

-- One function: '<absent>' or md5(definition) | sorted ACL.
CREATE FUNCTION pg_temp.fn_fp(p_sig text) RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN to_regprocedure(p_sig) IS NULL THEN p_sig || ' <absent>'
              ELSE p_sig || ' ' || md5(pg_get_functiondef(to_regprocedure(p_sig))) || ' ' || pg_temp.acl(to_regprocedure(p_sig)) END $f$;

-- Catalogue fingerprint for every object 3538 touches: the 3679 fingerprint
-- (policies, triggers, guard ACL) plus the guard's definition and both other functions.
CREATE FUNCTION pg_temp.fp3538() RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.fp() || ' ' || md5(concat_ws(E'\n',
    pg_temp.fn_fp('public.guard_invite_acceptance()'),
    pg_temp.fn_fp('public.claim_pending_invite()'),
    pg_temp.fn_fp('public.handle_new_user_invitation_link()')))
$f$;

CREATE FUNCTION pg_temp.guard_md5() RETURNS text LANGUAGE sql AS $f$
  SELECT md5(pg_get_functiondef(to_regprocedure('public.guard_invite_acceptance()'))) $f$;
