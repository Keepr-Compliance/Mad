-- BACKLOG-3968 PR-5 probe. Runs in ONE transaction that ends with ROLLBACK:
-- nothing it inserts survives. Run against keepr-test only:
--   ~/.claude/bin/kt-sql supabase/tests/backlog-3968/probe.sql
-- or with the migration (or a mutant of it) prepended, see run.sh.
-- The last SELECT is the verdict: PASS, or FAIL with the failed checks named.
-- The agent is the first active agent member whose organization has
-- transaction_checklists (picked at run time; no id is written here).
BEGIN;
--@@MIGRATION@@

CREATE TEMP TABLE probe_ctx (uid uuid, org uuid, sid uuid) ON COMMIT DROP;
CREATE TEMP TABLE probe_out (k text, v jsonb) ON COMMIT DROP;
GRANT ALL ON probe_ctx, probe_out TO authenticated;

DO $p$
DECLARE
  v_uid uuid; v_org uuid; v_sid uuid := gen_random_uuid();
BEGIN
  FOR v_uid, v_org IN
    SELECT om.user_id, om.organization_id FROM public.organization_members om
     WHERE om.role = 'agent' AND om.user_id IS NOT NULL
       AND public.member_status_grants_access(om.license_status)
     ORDER BY om.organization_id, om.user_id
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    EXIT WHEN COALESCE((public.check_feature_access(v_org, 'transaction_checklists') ->> 'allowed')::boolean, false);
    v_uid := NULL;
  END LOOP;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'probe: no entitled agent on this project'; END IF;

  INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status)
  VALUES (v_sid, v_org, v_uid, 'probe-3968', 'Probe 3968', 'uploading');
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path, document_type, local_attachment_id)
  VALUES (v_sid, 'probe-3968.pdf', 'probe-3968/a.pdf', 'other', 'p3968-att');
  -- Row shapes transcribed from the desktop uploader (electron/services/submissionService.ts):
  -- emails: channel 'email', message_type 'email'; texts: channel = messages.channel || 'email',
  -- message_type = messages.message_type || 'text'.
  INSERT INTO public.submission_messages (submission_id, local_message_id, channel, message_type, external_id) VALUES
    (v_sid, 'p3968-email',  'email',    'email', NULL),
    (v_sid, 'p3968-sms',    'sms',      'text',  NULL),
    (v_sid, 'p3968-imsg',   'imessage', 'text',  NULL),
    (v_sid, 'p3968-null',   NULL,       'text',  NULL),   -- channel NULL in the cloud row
    (v_sid, 'p3968-legacy', 'email',    'text',  NULL),   -- local NULL channel, uploaded as 'email'
    (v_sid, 'p3968-copy',   'sms',      'text',  'p3968-ext-1');
  INSERT INTO probe_ctx VALUES (v_uid, v_org, v_sid);
END
$p$;

SELECT set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) FROM probe_ctx;
SET LOCAL ROLE authenticated;

DO $p$
DECLARE
  v_sid uuid := (SELECT sid FROM probe_ctx);
  r jsonb;
BEGIN
  r := public.snapshot_submission_checklists(v_sid, jsonb_build_array(jsonb_build_object(
         'template_name', 'Probe', 'sort_order', 0,
         'items', jsonb_build_array(jsonb_build_object('title', 'Item', 'local_item_id', 'p3968-item',
           'links', jsonb_build_array(
             jsonb_build_object('kind', 'attachment', 'label', 'A', 'local_ids', jsonb_build_array('p3968-att')),
             jsonb_build_object('kind', 'email', 'label', 'E', 'local_ids', jsonb_build_array('p3968-email')),
             jsonb_build_object('kind', 'text', 'label', 'T',
               'local_ids',    jsonb_build_array('p3968-sms', 'p3968-imsg', 'p3968-null', 'p3968-legacy', 'p3968-email', 'p3968-other-copy', 'p3968-gone'),
               'external_ids', jsonb_build_array(NULL, NULL, NULL, NULL, NULL, 'p3968-ext-1', 'p3968-ext-none'))))))));
  INSERT INTO probe_out VALUES ('result', r);

  BEGIN
    PERFORM public.snapshot_submission_checklists(v_sid, '[{"template_name":"F","items":[{"title":"I","links":[{"kind":"fax","label":"F","local_ids":["x"]}]}]}]'::jsonb);
    INSERT INTO probe_out VALUES ('fax', '"accepted"');
  EXCEPTION WHEN others THEN INSERT INTO probe_out VALUES ('fax', to_jsonb(SQLERRM));
  END;

  -- Policy: a text member naming an email row, and an email member naming a text row, are refused.
  BEGIN
    INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_message_id)
    SELECT v_sid, l.id, 'text', m.id FROM public.submission_checklist_links l, public.submission_messages m
     WHERE l.submission_id = v_sid AND l.kind = 'text' AND m.submission_id = v_sid AND m.local_message_id = 'p3968-email';
    INSERT INTO probe_out VALUES ('policy_text_on_email', '"accepted"');
  EXCEPTION WHEN others THEN INSERT INTO probe_out VALUES ('policy_text_on_email', to_jsonb(SQLSTATE));
  END;
  BEGIN
    INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_message_id)
    SELECT v_sid, l.id, 'email', m.id FROM public.submission_checklist_links l, public.submission_messages m
     WHERE l.submission_id = v_sid AND l.kind = 'email' AND m.submission_id = v_sid AND m.local_message_id = 'p3968-sms';
    INSERT INTO probe_out VALUES ('policy_email_on_text', '"accepted"');
  EXCEPTION WHEN others THEN INSERT INTO probe_out VALUES ('policy_email_on_text', to_jsonb(SQLSTATE));
  END;

  INSERT INTO probe_out
  SELECT 'members', COALESCE(jsonb_object_agg(k, ids), '{}'::jsonb) FROM (
    SELECT lm.kind AS k, jsonb_agg(COALESCE(a.local_attachment_id, m.local_message_id) ORDER BY COALESCE(a.local_attachment_id, m.local_message_id)) AS ids
      FROM public.submission_checklist_link_members lm
      LEFT JOIN public.submission_attachments a ON a.id = lm.submission_attachment_id
      LEFT JOIN public.submission_messages m ON m.id = lm.submission_message_id
     WHERE lm.submission_id = v_sid GROUP BY lm.kind) s;
  INSERT INTO probe_out SELECT 'link_kinds', jsonb_agg(kind ORDER BY kind) FROM public.submission_checklist_links WHERE submission_id = v_sid;
  INSERT INTO probe_out VALUES ('caps', public.submission_checklist_capabilities());
END
$p$;

RESET ROLE;

WITH o AS (SELECT jsonb_object_agg(k, v) AS j FROM probe_out),
c AS (
  SELECT name, ok FROM o, LATERAL (VALUES
    ('counts',           (j -> 'result' ->> 'links')::int = 3 AND (j -> 'result' ->> 'members')::int = 7
                         AND (j -> 'result' ->> 'dropped_members')::int = 2 AND (j -> 'result' ->> 'dropped_links')::int = 0),
    ('attachment_member', j -> 'members' -> 'attachment' = '["p3968-att"]'::jsonb),
    ('email_member',      j -> 'members' -> 'email' = '["p3968-email"]'::jsonb),
    ('text_members',      j -> 'members' -> 'text' = '["p3968-copy","p3968-imsg","p3968-legacy","p3968-null","p3968-sms"]'::jsonb),
    ('link_kinds',        j -> 'link_kinds' = '["attachment","email","text"]'::jsonb),
    ('fax_refused',       j ->> 'fax' = 'invalid_payload'),
    ('policy_text_on_email', j ->> 'policy_text_on_email' = '42501'),
    ('policy_email_on_text', j ->> 'policy_email_on_text' = '42501'),
    ('caps_text',         (j -> 'caps' ->> 'text_links')::boolean IS TRUE)
  ) AS t(name, ok))
SELECT CASE WHEN bool_and(COALESCE(ok, false)) THEN 'PASS' ELSE 'FAIL' END AS verdict,
       string_agg(name, ', ') FILTER (WHERE NOT COALESCE(ok, false)) AS failed,
       (SELECT j - 'caps' FROM o) AS observed
  FROM c;
ROLLBACK;
