-- BACKLOG-3473 venue gate: catalog fingerprint.
--
-- Prints one `key|value` row per object the three migrations touch, depend on,
-- or whose data a control's expectation rests on. Run the SAME text on
-- production (read-only) and on the venue; lib/gate-expected.txt holds
-- production's output. run.sh gate compares them row by row.
--
-- Schema, policies, function definitions, grants, constraints, triggers and
-- the plan / feature catalogue only. No organization, user or submission row
-- is read.
--
-- Objects the migrations ADD are excluded by name (the new column, the two new
-- triggers on organization_plans, the transaction_checklists feature and its
-- plan rows), so the fingerprint is the same before migration 1 and after
-- teardown. The seven new tables and six new functions are not in any list.
--
-- Normalisation (as BACKLOG-3364's gate): CHECK and policy expressions have
-- casts to text / varchar, parentheses and whitespace stripped before hashing;
-- ACL entries for the venue-only role keepr_agent are dropped and the rest
-- sorted.

with
fn_names(n) as (values
  ('check_feature_access'), ('get_org_features'), ('broker_get_org_features'), ('tier_rank'),
  ('admin_assign_org_plan'), ('_ensure_personal_organization_for'), ('get_user_org_ids'),
  ('update_updated_at_column'), ('has_permission'), ('log_admin_action')
),
tbl(t) as (values
  ('public.organization_plans'), ('public.organizations'), ('public.organization_members'),
  ('public.plans'), ('public.plan_features'), ('public.feature_definitions'),
  ('public.transaction_submissions'), ('public.submission_attachments'), ('public.submission_messages'),
  ('public.internal_roles'), ('public.admin_roles'), ('public.admin_role_permissions'),
  ('public.admin_permissions'), ('public.licenses'), ('public.users')
),
new_cols(n) as (values ('local_attachment_id')),
new_trgs(n) as (values ('reject_feature_override_above_tier'), ('seed_checklists_on_plan_write')),
fn as (
  select 'fn:' || p.proname as k,
         md5(string_agg(pg_get_functiondef(p.oid), E'\n' order by pg_get_function_identity_arguments(p.oid))) as v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select n from fn_names)
  group by p.proname
),
fnmeta as (
  select 'fnmeta:' || p.proname as k,
         string_agg(p.prosecdef::text || '/' || p.provolatile::text || '/' || coalesce(p.proconfig::text, ''), ','
                    order by pg_get_function_identity_arguments(p.oid)) as v
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
  left join pg_policies p on p.schemaname || '.' || p.tablename = tbl.t
  group by t
),
trg as (
  select 'trg:' || t as k,
         md5(coalesce(string_agg(pg_get_triggerdef(g.oid), E'\n' order by g.tgname), '')) as v
  from tbl
  left join pg_trigger g
    on g.tgrelid = t::regclass and not g.tgisinternal
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
  group by t
),
relacl as (
  select 'relacl:' || t as k,
         md5(coalesce((select string_agg(a, ',' order by a)
                       from unnest((select relacl::text[] from pg_class where oid = t::regclass)) a
                       where a not like 'keepr_agent=%'), '')) as v
  from tbl
),
rls as (
  select 'rls:' || t as k,
         (select relrowsecurity || '/' || relforcerowsecurity || '/' || pg_get_userbyid(relowner)
          from pg_class where oid = t::regclass) as v
  from tbl
),
features as (
  select 'feature:' || fd.key as k,
         coalesce(fd.min_tier, 'NULL') || '/' || coalesce(fd.default_value, 'NULL') || '/' ||
         fd.value_type || '/' || fd.category || '/' || fd.is_built::text as v
  from public.feature_definitions fd
  where fd.key <> 'transaction_checklists'
),
plan_rows as (
  select 'plan:' || p.slug as k,
         p.tier || '/' || coalesce(p.is_default::text, 'NULL') || '/' || coalesce(p.is_active::text, 'NULL') as v
  from public.plans p
  where p.slug in ('individual', 'team', 'enterprise', 'keepr-internal')
),
plan_feature_rows as (
  select 'plan_feature:' || p.slug || ':' || fd.key as k,
         pf.enabled::text || '/' || coalesce(pf.value, 'NULL') as v
  from public.plan_features pf
  join public.plans p on p.id = pf.plan_id
  join public.feature_definitions fd on fd.id = pf.feature_id
  where p.slug in ('individual', 'team', 'enterprise', 'keepr-internal')
    and fd.key <> 'transaction_checklists'
),
settings as (
  select 'setting:server_version_major' as k, split_part(current_setting('server_version'), '.', 1) as v
  union all
  select 'role:postgres_rolbypassrls', (select rolbypassrls::text from pg_roles where rolname = 'postgres')
  union all
  select 'perm:plans.manage', (select count(*)::text from public.admin_permissions where key = 'plans.manage')
)
select k || '|' || v
from (
  select * from fn union all select * from fnmeta union all select * from fnacl
  union all select * from cols union all select * from pol union all select * from trg
  union all select * from con union all select * from relacl union all select * from rls
  union all select * from features union all select * from plan_rows union all select * from plan_feature_rows
  union all select * from settings
) x
order by 1;
