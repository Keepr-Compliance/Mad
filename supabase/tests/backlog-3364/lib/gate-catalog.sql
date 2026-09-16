-- BACKLOG-3364 venue gate: catalog fingerprint.
--
-- Prints one `key|md5` row per object migration 1 touches or depends on. Run
-- the SAME text on production (read-only) and on the venue; lib/gate-expected.txt
-- holds production's output. run.sh compares them row by row.
--
-- Objects migration 1 ADDS are excluded by name (the new column, its foreign
-- key, the two new triggers), so the fingerprint of the objects it does not
-- change is identical before and after the apply. The two policies it
-- REPLACES are fingerprinted separately (keys `policy:s2` and `policy:s3`),
-- and gate-expected.txt lists both their pre- and post-migration values.
--
-- Normalisation, and why:
--   constraints  pg_dump re-parses CHECK expressions (and a policy re-created
--   + policies   from pg_policies text is re-parsed too), so the same expression renders
--                as `(ARRAY['a'::varchar, ...])::text[]` on one cluster and
--                `ARRAY[('a'::varchar)::text, ...]` on another. Casts to text /
--                varchar, parentheses and whitespace are stripped before hashing.
--   ACLs         entries for the venue-only role keepr_agent are dropped and the
--                remaining entries sorted, so grant ORDER does not count.

with
fn_names(n) as (values
  ('admin_assign_org_plan'), ('admin_create_organization'), ('auto_provision_it_admin'),
  ('check_feature_access'), ('claim_pending_invite'), ('create_active_individual_license'),
  ('get_org_features'), ('get_user_org_ids'), ('handle_new_user'), ('has_internal_role'),
  ('has_permission'), ('is_org_admin'), ('jit_join_organization'), ('update_updated_at_column')
),
tbl(t) as (values
  ('public.licenses'), ('public.organization_members'), ('public.organization_plans'),
  ('public.organizations'), ('public.plans'), ('public.transaction_submissions'), ('public.users')
),
new_cols(n) as (values ('personal_owner_user_id')),
new_cons(n) as (values ('organizations_personal_owner_user_id_fkey')),
new_trgs(n) as (values ('guard_personal_owner_user_id'), ('retire_personal_membership')),
fn as (
  select 'fn:' || p.proname as k,
         md5(string_agg(pg_get_functiondef(p.oid), E'\n' order by pg_get_function_identity_arguments(p.oid))) as v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select n from fn_names)
  group by p.proname
),
fnacl as (
  select 'fnacl:' || p.proname as k,
         md5(coalesce((select string_agg(a, ',' order by a)
                       from unnest(p.proacl::text[]) a
                       where a not like 'keepr_agent=%'), '')) as v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select n from fn_names)
),
cols as (
  select 'cols:' || t as k,
         md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                        coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || a.attnotnull,
                        ',' order by a.attname)) as v
  from tbl
  join pg_attribute a on a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attname not in (select n from new_cols)
  group by t
),
pol as (
  select 'pol:' || t as k,
         md5(coalesce(string_agg(p.policyname || '|' || p.cmd || '|' || p.roles::text || '|' || p.permissive || '|' ||
                                 regexp_replace(regexp_replace(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''),
                                                '::(character varying|text)(\[\])?', '', 'g'), '[[:space:]()]', '', 'g'),
                                 E'\n' order by p.policyname), '')) as v
  from tbl
  left join pg_policies p
    on p.schemaname || '.' || p.tablename = tbl.t
   and not (p.schemaname = 'public' and p.tablename = 'transaction_submissions'
            and p.policyname = 'agents_can_create_submissions')
  group by t
),
pol_storage as (
  select 'pol:storage.objects:submission-attachments-unchanged' as k,
         md5(coalesce(string_agg(p.policyname || '|' || p.cmd || '|' || p.roles::text || '|' || p.permissive || '|' ||
                                 regexp_replace(regexp_replace(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''),
                                                '::(character varying|text)(\[\])?', '', 'g'), '[[:space:]()]', '', 'g'),
                                 E'\n' order by p.policyname), '')) as v
  from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects'
    and p.policyname in ('Admins can delete submission attachments',
                         'Members can update submission attachments',
                         'Members can view submission attachments')
),
policy_s2 as (
  select 'policy:s2' as k,
         md5(coalesce(string_agg(p.policyname || '|' || p.cmd || '|' || p.roles::text || '|' || p.permissive || '|' ||
                                 regexp_replace(regexp_replace(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''),
                                                '::(character varying|text)(\[\])?', '', 'g'), '[[:space:]()]', '', 'g'), E'\n'), '')) as v
  from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'transaction_submissions'
    and p.policyname = 'agents_can_create_submissions'
),
policy_s3 as (
  select 'policy:s3' as k,
         md5(coalesce(string_agg(p.policyname || '|' || p.cmd || '|' || p.roles::text || '|' || p.permissive || '|' ||
                                 regexp_replace(regexp_replace(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''),
                                                '::(character varying|text)(\[\])?', '', 'g'), '[[:space:]()]', '', 'g'), E'\n'), '')) as v
  from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects'
    and p.policyname = 'Members can upload submission attachments'
),
trg as (
  select 'trg:' || t as k,
         md5(coalesce(string_agg(pg_get_triggerdef(g.oid), E'\n' order by g.tgname), '')) as v
  from (select t from tbl union all select 'auth.users') tt(t)
  left join pg_trigger g
    on g.tgrelid = tt.t::regclass and not g.tgisinternal
   and g.tgname not in (select n from new_trgs)
  group by t
),
con as (
  select 'con:' || t as k,
         md5(string_agg(c.conname || ':' ||
                        regexp_replace(regexp_replace(pg_get_constraintdef(c.oid),
                                                      '::(character varying|text)(\[\])?', '', 'g'),
                                       '[[:space:]()]', '', 'g'),
                        E'\n' order by c.conname)) as v
  from tbl
  join pg_constraint c on c.conrelid = t::regclass
  where c.conname not in (select n from new_cons)
  group by t
),
relacl as (
  select 'relacl:' || t as k,
         md5(coalesce((select string_agg(a, ',' order by a)
                       from unnest((select relacl::text[] from pg_class where oid = t::regclass)) a
                       where a not like 'keepr_agent=%'), '')) as v
  from (select t from tbl union all select 'storage.objects' union all select 'storage.buckets') tt(t)
),
rls as (
  select 'rls:' || t as k,
         (select relrowsecurity || '/' || relforcerowsecurity || '/' || pg_get_userbyid(relowner)
          from pg_class where oid = t::regclass) as v
  from (select t from tbl union all select 'storage.objects' union all select 'storage.buckets') tt(t)
),
settings as (
  select 'setting:server_version_major' as k, split_part(current_setting('server_version'), '.', 1) as v
  union all
  select 'setting:session_preload_libraries_has_supautils',
         (position('supautils' in coalesce(current_setting('session_preload_libraries', true), '') ||
                                  ',' || coalesce(current_setting('shared_preload_libraries', true), '')) > 0)::text
  union all
  select 'setting:policy_grants_md5', md5(coalesce(current_setting('supautils.policy_grants', true), ''))
  union all
  select 'setting:policy_grants_postgres_storage_objects',
         (coalesce(current_setting('supautils.policy_grants', true), '{}')::jsonb -> 'postgres' ? 'storage.objects')::text
  union all
  select 'role:postgres_rolsuper', (select rolsuper::text from pg_roles where rolname = 'postgres')
  union all
  select 'role:postgres_member_of_storage_admin', pg_has_role('postgres', 'supabase_storage_admin', 'USAGE')::text
  union all
  select 'priv:authenticated_insert_storage_objects', has_table_privilege('authenticated', 'storage.objects', 'INSERT')::text
  union all
  select 'bucket:submission-attachments',
         coalesce((select id || '/' || public::text from storage.buckets where id = 'submission-attachments'), 'absent')
)
select k || '|' || v
from (
  select * from fn union all select * from fnacl union all select * from cols
  union all select * from pol union all select * from pol_storage
  union all select * from policy_s2 union all select * from policy_s3
  union all select * from trg union all select * from con
  union all select * from relacl union all select * from rls union all select * from settings
) x
order by 1;
