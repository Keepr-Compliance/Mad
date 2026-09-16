-- BACKLOG-3364: fingerprint of every object migration 1 creates or replaces.
-- Used by run.sh's one-transaction and apply-twice controls: the fingerprint
-- before and after a run is compared as a whole.

SELECT 'col|'     || coalesce((SELECT format_type(atttypid, atttypmod) || ' notnull=' || attnotnull
                               FROM pg_attribute
                               WHERE attrelid = 'public.organizations'::regclass
                                 AND attname = 'personal_owner_user_id' AND NOT attisdropped), 'absent')
UNION ALL
SELECT 'comment|' || coalesce(md5(col_description('public.organizations'::regclass,
                               (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.organizations'::regclass
                                AND attname = 'personal_owner_user_id' AND NOT attisdropped)::int)), 'absent')
UNION ALL
SELECT 'index|'   || coalesce((SELECT pg_get_indexdef(c.oid) FROM pg_class c
                               WHERE c.relname = 'organizations_personal_owner_user_id_key'
                                 AND c.relnamespace = 'public'::regnamespace), 'absent')
UNION ALL
SELECT 'fk|'      || coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conname = 'organizations_personal_owner_user_id_fkey'), 'absent')
UNION ALL
SELECT 'fn|' || f || '|' || coalesce((SELECT md5(pg_get_functiondef(to_regprocedure(f))) || ' acl=' ||
                                             coalesce((SELECT string_agg(a, ',' ORDER BY a)
                                                       FROM unnest((SELECT proacl::text[] FROM pg_proc WHERE oid = to_regprocedure(f))) a
                                                       WHERE a NOT LIKE 'keepr_agent=%'), 'default')), 'absent')
FROM unnest(ARRAY['public._ensure_personal_organization_for(uuid)',
                  'public.ensure_personal_organization()',
                  'public._guard_personal_owner_user_id()',
                  'public._retire_personal_membership()']) f
UNION ALL
SELECT 'triggers|' || t || '|' || coalesce((SELECT md5(string_agg(pg_get_triggerdef(oid), E'\n' ORDER BY tgname))
                                            FROM pg_trigger WHERE tgrelid = t::regclass AND NOT tgisinternal), 'none')
FROM unnest(ARRAY['public.organizations', 'public.organization_members', 'auth.users']) t
UNION ALL
SELECT 'policy|' || p.schemaname || '.' || p.tablename || '|' || p.policyname || '|' ||
       md5(p.cmd || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))
FROM pg_policies p
WHERE (p.schemaname = 'public'  AND p.tablename = 'transaction_submissions' AND p.policyname = 'agents_can_create_submissions')
   OR (p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'Members can upload submission attachments')
ORDER BY 1;
