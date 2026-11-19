-- BACKLOG-4263 PR-11a harness: catalogue, row-version and timing probes (counts, md5s and times only).

-- Every catalogue fact 20261119100000 touches, for the before / after / after-rollback comparison
CREATE FUNCTION pg_temp.cat() RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT jsonb_build_object(
    'item_json_md5', (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public._cloud_todo_item_json(public.cloud_deal_checklist_items)')),
    'item_json_attrs', (SELECT jsonb_build_array(p.proacl::text, p.prosecdef, p.provolatile, p.proconfig, p.proowner::regrole::text)
                          FROM pg_proc p WHERE p.oid = to_regprocedure('public._cloud_todo_item_json(public.cloud_deal_checklist_items)')),
    'snap_md5', (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.snapshot_submission_checklists(uuid,jsonb)')),
    'snap_attrs', (SELECT jsonb_build_array(p.proacl::text, p.prosecdef, p.provolatile, p.proconfig, p.proowner::regrole::text)
                     FROM pg_proc p WHERE p.oid = to_regprocedure('public.snapshot_submission_checklists(uuid,jsonb)')),
    'snap_count', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'snapshot_submission_checklists'),
    'part_app', to_regprocedure('public._cloud_todo_part_app()') IS NOT NULL,
    'triggers_items', (SELECT coalesce(string_agg(t.tgname::text, ',' ORDER BY t.tgname), '') FROM pg_trigger t
                        WHERE t.tgrelid = 'public.cloud_deal_checklist_items'::regclass AND NOT t.tgisinternal),
    'triggers_sub', (SELECT coalesce(string_agg(t.tgname::text, ',' ORDER BY t.tgname), '') FROM pg_trigger t
                      WHERE t.tgrelid = 'public.submission_checklist_items'::regclass AND NOT t.tgisinternal),
    'cols_items', (SELECT md5(string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || a.attnotnull::text, ',' ORDER BY a.attnum))
                     FROM pg_attribute a WHERE a.attrelid = 'public.cloud_deal_checklist_items'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
    'cols_sub', (SELECT md5(string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || a.attnotnull::text, ',' ORDER BY a.attnum))
                   FROM pg_attribute a WHERE a.attrelid = 'public.submission_checklist_items'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
    'new_cols', (SELECT coalesce(string_agg(a.attrelid::regclass::text || '.' || a.attname, ',' ORDER BY 1), '') FROM pg_attribute a
                  WHERE a.attrelid IN ('public.cloud_deal_checklist_items'::regclass, 'public.submission_checklist_items'::regclass)
                    AND a.attname IN ('done_app', 'note_app', 'attribution_v', 'note_by_kind', 'note_by_app') AND NOT a.attisdropped),
    'cons_items', (SELECT md5(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), ',' ORDER BY c.conname)) FROM pg_constraint c
                     WHERE c.conrelid = 'public.cloud_deal_checklist_items'::regclass),
    'cons_sub', (SELECT md5(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), ',' ORDER BY c.conname)) FROM pg_constraint c
                   WHERE c.conrelid = 'public.submission_checklist_items'::regclass),
    'acl_items', (SELECT c.relacl::text FROM pg_class c WHERE c.oid = 'public.cloud_deal_checklist_items'::regclass),
    'acl_sub', (SELECT c.relacl::text FROM pg_class c WHERE c.oid = 'public.submission_checklist_items'::regclass),
    'rls', (SELECT jsonb_agg(jsonb_build_array(c.relname, c.relrowsecurity, c.relforcerowsecurity) ORDER BY c.relname) FROM pg_class c
             WHERE c.oid IN ('public.cloud_deal_checklist_items'::regclass, 'public.submission_checklist_items'::regclass)),
    'policies', (SELECT jsonb_agg(jsonb_build_array(y.polrelid::regclass::text, y.polname, y.polcmd, y.polroles::regrole[]::text,
                                                    md5(coalesce(pg_get_expr(y.polqual, y.polrelid), '')), md5(coalesce(pg_get_expr(y.polwithcheck, y.polrelid), '')))
                                  ORDER BY y.polrelid::regclass::text, y.polname) FROM pg_policy y
                  WHERE y.polrelid IN ('public.cloud_deal_checklist_items'::regclass, 'public.submission_checklist_items'::regclass)),
    'insert_policy', (SELECT y.polname || ' ' || y.polcmd || ' ' || y.polroles::regrole[]::text FROM pg_policy y
                       WHERE y.polrelid = 'public.submission_checklist_items'::regclass AND y.polcmd = 'a'),
    'fn_count_public', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
    'anon_mcp', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'
                    AND has_function_privilege('anon', p.oid, 'EXECUTE')),
    'anon_internal', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^(ai_app_|_mcp_|_cloud_)'
                        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))))
$h$;
-- the facts the rollback must restore: everything in cat() except counts that the harness's own rows can move
CREATE FUNCTION pg_temp.cat_cmp(x jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$ SELECT x $h$;
-- row versions of both tables (no content): equal before and after the apply means no row was rewritten
CREATE FUNCTION pg_temp.rowver() RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT jsonb_build_object(
    'items_n', (SELECT count(*) FROM public.cloud_deal_checklist_items),
    'items_v', (SELECT md5(coalesce(string_agg(t.ctid::text || t.xmin::text, ',' ORDER BY t.id), '')) FROM public.cloud_deal_checklist_items t),
    'sub_n', (SELECT count(*) FROM public.submission_checklist_items),
    'sub_v', (SELECT md5(coalesce(string_agg(t.ctid::text || t.xmin::text, ',' ORDER BY t.id), '')) FROM public.submission_checklist_items t)) $h$;

-- one 200-item desktop push (creates) and one 200-op push (done set) on deal dk of B; times in ms
CREATE FUNCTION pg_temp.timed(dk text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE ops jsonb; t0 timestamptz; c_ms numeric; s_ms numeric; r1 jsonb; r2 jsonb; B uuid := pg_temp.id('B'); IB uuid := pg_temp.id('IB');
BEGIN
  ops := (SELECT jsonb_agg(pg_temp.ci(pg_temp.id(dk), lower(dk) || '-my', lower(dk) || '-x' || g, 'Timed ' || g, g)) FROM generate_series(1, 200) g);
  t0 := clock_timestamp();
  r1 := pg_temp.push(B, IB, ops);
  c_ms := round(extract(epoch FROM clock_timestamp() - t0)::numeric * 1000, 1);
  ops := (SELECT jsonb_agg(pg_temp.op_set(t.id, 'done', jsonb_build_object('is_checked', true, 'checked_at', NULL), 2))
            FROM public.cloud_deal_checklist_items t WHERE t.cloud_deal_id = pg_temp.id(dk));
  t0 := clock_timestamp();
  r2 := pg_temp.push(B, IB, ops);
  s_ms := round(extract(epoch FROM clock_timestamp() - t0)::numeric * 1000, 1);
  RETURN jsonb_build_object('create_ms', c_ms, 'set_ms', s_ms,
    'created', (SELECT count(*) FROM jsonb_array_elements(r1 -> 'results') x WHERE x ->> 'status' = 'added'),
    'set', (SELECT count(*) FROM jsonb_array_elements(r2 -> 'results') x WHERE x ->> 'status' = 'applied'),
    'err', coalesce(r1 ->> 'error', r2 ->> 'error'));
END $h$;
