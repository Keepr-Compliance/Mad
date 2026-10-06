-- BACKLOG-3473: the venue's catalogue must equal production's, hashed the same
-- way on both sides (production read-only, 2026-09-21). Included by
-- venue-catalogue.sql after it writes, and by venue-catalogue-teardown.sql
-- before it deletes, so teardown removes only the set the seed wrote.
-- Raises on any difference, which rolls the enclosing transaction back.
-- transaction_checklists is excluded: migration 2 adds it, teardown.sql removes it.

DO $verify$
DECLARE
  got text;
  r   record;
BEGIN
  FOR r IN
    SELECT 'feature_definitions' AS what, 25::bigint AS want_n, '723ec8e98746b6bd02efc80f1a30a828' AS want_h,
           (SELECT count(*) FROM public.feature_definitions WHERE key <> 'transaction_checklists') AS n,
           (SELECT md5(string_agg(key || '|' || name || '|' || value_type || '|' || coalesce(default_value, 'NULL') || '|' ||
                                  category || '|' || coalesce(sort_order::text, 'NULL') || '|' || coalesce(min_tier, 'NULL') || '|' ||
                                  is_built::text, E'\n' ORDER BY key))
              FROM public.feature_definitions WHERE key <> 'transaction_checklists') AS h
    UNION ALL
    SELECT 'plans', 4, '3e2753f85a27be4ddac56b2b18d87798',
           (SELECT count(*) FROM public.plans),
           (SELECT md5(string_agg(slug || '|' || name || '|' || tier || '|' || coalesce(is_default::text, 'NULL') || '|' ||
                                  coalesce(is_active::text, 'NULL') || '|' || coalesce(sort_order::text, 'NULL'), E'\n' ORDER BY slug))
              FROM public.plans)
    UNION ALL
    SELECT 'plan_features', 100, '3a095417e6a99772a7b18fcd123f3134',
           (SELECT count(*) FROM public.plan_features pf JOIN public.feature_definitions fd ON fd.id = pf.feature_id
             WHERE fd.key <> 'transaction_checklists'),
           (SELECT md5(string_agg(p.slug || ':' || fd.key || '|' || pf.enabled::text || '/' || coalesce(pf.value, 'NULL'),
                                  E'\n' ORDER BY p.slug, fd.key))
              FROM public.plan_features pf
              JOIN public.plans p ON p.id = pf.plan_id
              JOIN public.feature_definitions fd ON fd.id = pf.feature_id
             WHERE fd.key <> 'transaction_checklists')
    UNION ALL
    SELECT 'admin_permissions', 1, 'a7cafc4b2effba5f31e6a954c5e3d5d3',
           (SELECT count(*) FROM public.admin_permissions),
           (SELECT md5(key || '|' || label || '|' || category) FROM public.admin_permissions WHERE key = 'plans.manage')
  LOOP
    IF r.n <> r.want_n OR r.h IS DISTINCT FROM r.want_h THEN
      RAISE EXCEPTION 'venue catalogue: % holds % row(s) hashing %, production has % hashing %',
        r.what, r.n, r.h, r.want_n, r.want_h;
    END IF;
  END LOOP;
  RAISE NOTICE 'venue catalogue verified: 25 features, 4 plans, 100 plan rows, plans.manage -- equal to production';
END
$verify$;
