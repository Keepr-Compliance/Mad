-- BACKLOG-3607 fixtures: helper functions only, no rows. Loaded before any
-- 3596 file. Builds on the 3473 / 3477 / 3596 fixtures. ALL IDENTIFIERS ARE
-- INVENTED. Rows are made through the real producers (snapshot RPC as the
-- agent, tick / add / remove / restore RPCs as the broker); the owner only
-- inserts version rows and moves statuses, as the desktop and portal do.
SET LOCAL check_function_bodies = off;

-- snap3607(): snap3596 plus the two new functions.
CREATE FUNCTION pg_temp.snap3607() RETURNS TABLE (k text, v text)
LANGUAGE sql AS $$
  SELECT * FROM pg_temp.snap3596()
  UNION ALL
  SELECT 'function:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '')
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('remove_submission_checklist_at_review', 'restore_submission_checklist_at_review')
$$;

-- remove_as(uid, checklist): the remove RPC as that user.
CREATE FUNCTION pg_temp.remove_as(p_uid uuid, p_hdr uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE res jsonb;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  res := public.remove_submission_checklist_at_review(p_hdr);
  PERFORM pg_temp.act_owner();
  RETURN res;
END
$$;

-- restore_as(uid, submission, source checklist): the restore RPC as that user.
CREATE FUNCTION pg_temp.restore_as(p_uid uuid, p_sub uuid, p_src uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE res jsonb;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  res := public.restore_submission_checklist_at_review(p_sub, p_src);
  PERFORM pg_temp.act_owner();
  RETURN res;
END
$$;

-- hdr(sub, name): that version's header id by checklist name.
CREATE FUNCTION pg_temp.hdr(p_sub uuid, p_name text) RETURNS uuid
LANGUAGE sql AS $$
  SELECT id FROM public.submission_checklists WHERE submission_id = p_sub AND template_name = p_name
$$;

-- vd(sub): the version-diff entries of a version as 'type:name[:flags]', in order.
CREATE FUNCTION pg_temp.vd(p_sub uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(e ->> 'type' || ':' || (e ->> 'checklist_name')
           || CASE WHEN (e ->> 'added_at_review')::boolean THEN ':added_at_review' ELSE '' END
           || CASE WHEN (e ->> 'after_broker_removal')::boolean THEN ':after_broker_removal' ELSE '' END
           || CASE WHEN (e ->> 'replaced')::boolean THEN ':replaced' ELSE '' END
           || CASE WHEN (e ->> 'parent_had_none')::boolean THEN ':parent_had_none' ELSE '' END, ',' ORDER BY o), '')
    FROM jsonb_array_elements(pg_temp.hist(p_sub)) WITH ORDINALITY AS x(e, o)
   WHERE e ->> 'source' = 'version'
$$;

-- rm_v2(txn): v1 = the reviewed base deal (A + B, 5 ticks); v2 sends B only
-- (the agent removed A), resubmitted. Returns v2.
CREATE FUNCTION pg_temp.rm_v2(p_txn text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v1 uuid; v2 uuid;
BEGIN
  v1 := pg_temp.build_v1(p_txn);
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(pg_temp.id('u_t1_agent'), v2, pg_temp.pb());
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  RETURN v2;
END
$$;

SET LOCAL check_function_bodies = on;
SELECT 'fixtures-3607 loaded' AS fixtures;
