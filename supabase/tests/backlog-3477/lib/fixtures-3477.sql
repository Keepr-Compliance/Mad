-- BACKLOG-3477 fixtures. Loaded by run.sh after the 3477 migration, inside the
-- control's own transaction (always rolled back). Builds on
-- supabase/tests/backlog-3473/lib/fixtures.sql: its helpers (pg_temp.check,
-- act_as, act_owner, expect, id, n) and ids (published as t3473.<name>) are
-- reused, and the ids below are published the same way.
--
-- ALL IDENTIFIERS ARE INVENTED, in the 00000000-0000-4000-8000-00003477xxxx
-- block.
--
-- Loaded as the owner with no request JWT, so the append-only guard on
-- status_history is exempt here (auth.role() IS NULL).

-- act_service(): the PostgREST request shape for the service role.
CREATE FUNCTION pg_temp.act_service() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role": "service_role"}', true);
  PERFORM set_config('role', 'service_role', true);
END
$$;

-- hist(submission): the submission's status_history, read as the owner.
CREATE FUNCTION pg_temp.hist(p_sub uuid) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT COALESCE(status_history, '[]'::jsonb) FROM public.transaction_submissions WHERE id = p_sub
$$;

-- snap3477(): catalog rows for the apply-twice control.
CREATE FUNCTION pg_temp.snap3477() RETURNS TABLE (k text, v text)
LANGUAGE sql AS $$
  SELECT 'policy:' || tablename || '.' || policyname,
         cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('transaction_submissions', 'submission_messages', 'submission_attachments',
                       'submission_checklists', 'submission_checklist_items',
                       'submission_checklist_links', 'submission_checklist_link_members')
  UNION ALL
  SELECT 'constraint:' || conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
    FROM pg_constraint
   WHERE conrelid IN ('public.submission_checklists'::regclass, 'public.submission_checklist_items'::regclass)
  UNION ALL
  SELECT 'column:' || table_name || '.' || column_name, data_type || '|' || is_nullable || '|' || coalesce(column_default, '')
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('submission_checklists', 'submission_checklist_items')
  UNION ALL
  SELECT 'index:' || indexname, indexdef FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'submission_checklists'
  UNION ALL
  SELECT 'function:' || p.proname,
         md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '')
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('can_review_submission', 'snapshot_submission_checklists',
                       'set_submission_checklist_reviewer_check', 'add_submission_checklist_at_review',
                       'guard_status_history_append_only')
  UNION ALL
  SELECT 'trigger:' || tgname, pg_get_triggerdef(oid)
    FROM pg_trigger WHERE tgrelid = 'public.transaction_submissions'::regclass AND NOT tgisinternal
$$;

DO $fixtures3477$
DECLARE
  o_t1   uuid := current_setting('t3473.o_t1')::uuid;
  o_t2   uuid := current_setting('t3473.o_t2')::uuid;
  agent  uuid := current_setting('t3473.u_t1_agent')::uuid;
  broker uuid := current_setting('t3473.u_t1_broker')::uuid;
  t2agent uuid := current_setting('t3473.u_t2_agent')::uuid;
  -- submissions (T1 unless named)
  s_rev   uuid := '00000000-0000-4000-8000-00003477b001'; -- pii-allow-uuid: invented fixture id (under_review)
  s_resub uuid := '00000000-0000-4000-8000-00003477b002'; -- pii-allow-uuid: invented fixture id (resubmitted)
  s_appr  uuid := '00000000-0000-4000-8000-00003477b003'; -- pii-allow-uuid: invented fixture id (approved)
  s_rej   uuid := '00000000-0000-4000-8000-00003477b004'; -- pii-allow-uuid: invented fixture id (rejected)
  s_t2sub uuid := '00000000-0000-4000-8000-00003477b005'; -- pii-allow-uuid: invented fixture id (T2, submitted, feature off)
  -- attachments on S_up with local ids
  a6      uuid := '00000000-0000-4000-8000-00003477c006'; -- pii-allow-uuid: invented fixture id
  -- headers and items
  h_sub   uuid := '00000000-0000-4000-8000-00003477e001'; -- pii-allow-uuid: invented fixture id (S_sub)
  i_req   uuid := '00000000-0000-4000-8000-00003477e002'; -- pii-allow-uuid: invented fixture id (S_sub, required, agent-checked)
  i_opt   uuid := '00000000-0000-4000-8000-00003477e003'; -- pii-allow-uuid: invented fixture id (S_sub, optional)
  h_rev   uuid := '00000000-0000-4000-8000-00003477e004'; -- pii-allow-uuid: invented fixture id (S_rev)
  i_rev   uuid := '00000000-0000-4000-8000-00003477e005'; -- pii-allow-uuid: invented fixture id (S_rev)
  h_added uuid := '00000000-0000-4000-8000-00003477e006'; -- pii-allow-uuid: invented fixture id (S_rev, added at review)
  i_added uuid := '00000000-0000-4000-8000-00003477e007'; -- pii-allow-uuid: invented fixture id (S_rev, in the added header)
  h_appr  uuid := '00000000-0000-4000-8000-00003477e008'; -- pii-allow-uuid: invented fixture id
  i_appr  uuid := '00000000-0000-4000-8000-00003477e009'; -- pii-allow-uuid: invented fixture id
  h_rej   uuid := '00000000-0000-4000-8000-00003477e00a'; -- pii-allow-uuid: invented fixture id
  i_rej   uuid := '00000000-0000-4000-8000-00003477e00b'; -- pii-allow-uuid: invented fixture id
  h_up    uuid := '00000000-0000-4000-8000-00003477e00c'; -- pii-allow-uuid: invented fixture id (S_up, owner-inserted)
  i_up    uuid := '00000000-0000-4000-8000-00003477e00d'; -- pii-allow-uuid: invented fixture id
  h_t2    uuid := '00000000-0000-4000-8000-00003477e00e'; -- pii-allow-uuid: invented fixture id
  i_t2    uuid := '00000000-0000-4000-8000-00003477e00f'; -- pii-allow-uuid: invented fixture id
  h_resub uuid := '00000000-0000-4000-8000-00003477e010'; -- pii-allow-uuid: invented fixture id
  i_resub uuid := '00000000-0000-4000-8000-00003477e011'; -- pii-allow-uuid: invented fixture id
  s_up    uuid := current_setting('t3473.s_up')::uuid;
  s_sub   uuid := current_setting('t3473.s_sub')::uuid;
  s_nc    uuid := current_setting('t3473.s_nc')::uuid;
  r       record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('s_rev', s_rev), ('s_resub', s_resub), ('s_appr', s_appr), ('s_rej', s_rej), ('s_t2sub', s_t2sub),
    ('a6', a6), ('h_sub', h_sub), ('i_req', i_req), ('i_opt', i_opt), ('h_rev', h_rev), ('i_rev', i_rev),
    ('h_added', h_added), ('i_added', i_added), ('h_appr', h_appr), ('i_appr', i_appr),
    ('h_rej', h_rej), ('i_rej', i_rej), ('h_up', h_up), ('i_up', i_up), ('h_t2', h_t2), ('i_t2', i_t2),
    ('h_resub', h_resub), ('i_resub', i_resub)
  ) v(name, id) LOOP
    PERFORM set_config('t3473.' || r.name, r.id::text, true);
  END LOOP;

  -- S_up's attachments carry the desktop's local ids: A1 and A2 share one
  -- (two uploads of one local file), A6 has its own.
  UPDATE public.submission_attachments SET local_attachment_id = 'fixture-3477-local-a'
   WHERE id IN (current_setting('t3473.a1')::uuid, current_setting('t3473.a2')::uuid);
  INSERT INTO public.submission_attachments (id, submission_id, filename, storage_path, document_type, local_attachment_id)
  VALUES (a6, s_up, 'fixture-a6.pdf', 'fixture-3477/a6.pdf', 'other', 'fixture-3477-local-b');

  INSERT INTO public.transaction_submissions
    (id, organization_id, submitted_by, local_transaction_id, property_address, status) VALUES
    (s_rev,   o_t1, agent,   'fixture-3477-s-rev',   '11 Fixture Way', 'under_review'),
    (s_resub, o_t1, agent,   'fixture-3477-s-resub', '12 Fixture Way', 'resubmitted'),
    (s_appr,  o_t1, agent,   'fixture-3477-s-appr',  '13 Fixture Way', 'approved'),
    (s_rej,   o_t1, agent,   'fixture-3477-s-rej',   '14 Fixture Way', 'rejected'),
    (s_t2sub, o_t2, t2agent, 'fixture-3477-s-t2sub', '15 Fixture Way', 'submitted');

  -- One status entry on S_sub, as the status trigger writes it, so the
  -- append-only controls have an entry to try to change.
  UPDATE public.transaction_submissions
     SET status_history = jsonb_build_array(jsonb_build_object(
           'status', 'submitted', 'changed_at', '2026-09-01T10:00:00+00:00', 'changed_by', NULL, 'notes', NULL))
   WHERE id = s_sub;

  INSERT INTO public.submission_checklists (id, submission_id, template_name, sort_order, template_id) VALUES
    (h_sub,   s_sub,   'Fixture starter A', 0, NULLIF(current_setting('t3473.tpl_t1_a'), '')::uuid),
    (h_rev,   s_rev,   'Fixture starter B', 0, NULL),
    (h_appr,  s_appr,  'Fixture starter A', 0, NULL),
    (h_rej,   s_rej,   'Fixture starter A', 0, NULL),
    (h_up,    s_up,    'Fixture starter A', 0, NULL),
    (h_t2,    s_t2sub, 'Fixture starter A', 0, NULL),
    (h_resub, s_resub, 'Fixture starter A', 0, NULL);
  INSERT INTO public.submission_checklists
    (id, submission_id, template_name, sort_order, added_at_review_by, added_at_review_at)
  VALUES (h_added, s_rev, 'Fixture added at review', 1, broker, now());

  INSERT INTO public.submission_checklist_items
    (id, submission_id, submission_checklist_id, title, is_required, is_checked, sort_order) VALUES
    (i_req,   s_sub,   h_sub,   'Fixture item A1', true,  true,  10),
    (i_opt,   s_sub,   h_sub,   'Fixture item A2', false, false, 20),
    (i_rev,   s_rev,   h_rev,   'Fixture item B1', true,  false, 10),
    (i_added, s_rev,   h_added, 'Fixture added item', true, false, 10),
    (i_appr,  s_appr,  h_appr,  'Fixture item A1', true,  true,  10),
    (i_rej,   s_rej,   h_rej,   'Fixture item A1', true,  true,  10),
    (i_up,    s_up,    h_up,    'Fixture item A1', true,  true,  10),
    (i_t2,    s_t2sub, h_t2,    'Fixture item A1', true,  true,  10),
    (i_resub, s_resub, h_resub, 'Fixture item A1', true,  true,  10);

  -- An archived T1 template (starter B).
  UPDATE public.checklist_templates SET archived_at = now()
   WHERE id = NULLIF(current_setting('t3473.tpl_t1_b'), '')::uuid;
END
$fixtures3477$;

SELECT 'fixtures-3477 loaded' AS fixtures;
