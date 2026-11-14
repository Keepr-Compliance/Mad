SELECT jsonb_build_object(
 '4244_objects', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mcp_list_deals','mcp_get_deal','mcp_get_deal_checklists','_mcp_r_list_deals','_mcp_r_get_deal','_mcp_r_deal_checklists','_mcp_txt','_mcp_mask','_mcp_clean','_mcp_ts','_mcp_day')),
 'ledger_4244', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261114110000'),
 'call_log_checks', (SELECT string_agg(c.conname || '=' || pg_get_constraintdef(c.oid), '; ' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c'),
 'call_log_new_tools', (SELECT count(*) FROM public.mcp_call_log WHERE tool IN ('list_deals','get_deal','get_deal_checklists')),
 'mcp_functions_md5', md5((SELECT string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text,'-'), ',' ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_')),
 'mcp_function_count', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'),
 'cloud_writes_new_signature', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proargnames[1] = 'p_expected_user_id'),
 'fixture_users_left', (SELECT count(*) FROM auth.users WHERE email LIKE 'p4244-%'),
 'mcp_reader_bypassrls', (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'mcp_reader'),
 'rls_on', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.cloud_deals'::regclass,'public.cloud_deal_parties'::regclass,'public.cloud_deal_checklists'::regclass,'public.cloud_deal_checklist_items'::regclass)),
 'live_withheld_column', (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.cloud_deal_parties'::regclass AND attname = 'details_withheld' AND NOT attisdropped),
 'live_withheld_check', (SELECT count(*) FROM pg_constraint WHERE conname = 'cloud_deal_parties_withheld_ck'),
 'live_parties', (SELECT count(*) FROM public.cloud_deal_parties),
 'stat_reset', (SELECT extensions.pg_stat_statements_reset() IS NOT NULL OR true)
) AS after;
