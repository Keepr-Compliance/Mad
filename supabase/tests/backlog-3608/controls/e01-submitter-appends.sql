-- E01: the submitting agent cannot write status_history directly.
--   uploading v2 (the only version its UPDATE policy branch reaches): every
--     shape refused by the guard -- broker-type entry, agent-attributed
--     carry-type entry, an entry shaped as a status line, an entry naming
--     someone else, a whole-array replace, an edit of an existing entry, an
--     append together with the finalize status move.
--   needs_changes v1: the same appends match no row (rows:0).
-- History unchanged after every attempt.
DO $e01$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid := pg_temp.build_v1('fixture-3608-e01');   -- needs_changes, reviewed
  v2 uuid := pg_temp.new_version(v1, 2);             -- uploading
  h1 jsonb; h2 jsonb; e jsonb;
  shapes jsonb[];
  q text := $q$UPDATE public.transaction_submissions SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(%L::jsonb) WHERE id = %L$q$;
BEGIN
  -- give v2 one existing entry (owner write), so edits and replaces have a target
  UPDATE public.transaction_submissions
     SET status_history = jsonb_build_array(jsonb_build_object('type', 'checklist_review_cleared', 'reason', 'edited', 'changed_by', agent::text))
   WHERE id = v2;
  h1 := pg_temp.hist(v1); h2 := pg_temp.hist(v2);
  PERFORM pg_temp.check(jsonb_array_length(h1) > 0 AND jsonb_array_length(h2) = 1, 'E01 v1 and v2 have history to protect');
  shapes := ARRAY[
    jsonb_build_object('type', 'checklist_review', 'changed_by', agent, 'changed_at', now(), 'item_title', 'Item one', 'from', false, 'to', true),
    jsonb_build_object('type', 'checklist_added', 'changed_by', agent, 'changed_at', now(), 'checklist_name', 'Fixture'),
    jsonb_build_object('type', 'checklist_removed', 'source', 'version', 'checklist_key', 'k-fixture', 'changed_by', agent, 'changed_at', now()),
    jsonb_build_object('type', 'checklist_review_cleared', 'reason', 'edited', 'changed_by', agent, 'changed_at', now()),
    jsonb_build_object('type', 'checklist_review_unavailable', 'changed_by', agent, 'changed_at', now()),
    jsonb_build_object('type', 'x', 'status', 'approved', 'notes', 'Approved', 'changed_by', agent, 'changed_at', now()),
    jsonb_build_object('type', 'checklist_review', 'changed_by', broker, 'changed_at', now())];
  PERFORM pg_temp.act_as(agent);
  FOREACH e IN ARRAY shapes LOOP
    PERFORM pg_temp.expect(format('E01 agent appends %s (%s) on uploading v2', e ->> 'type', COALESCE(e ->> 'status', '-')),
                           format(q, e::text, v2), '~^42501:status_history_append_only$');
    PERFORM pg_temp.expect(format('E01 agent appends %s (%s) on needs_changes v1', e ->> 'type', COALESCE(e ->> 'status', '-')),
                           format(q, e::text, v1), 'rows:0');
  END LOOP;
  PERFORM pg_temp.expect('E01 agent replaces the whole array',
    format($q$UPDATE public.transaction_submissions SET status_history = %L::jsonb WHERE id = %L$q$,
           (h2 || jsonb_build_array(shapes[1]))::text, v2), '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('E01 agent edits entry 0',
    format($q$UPDATE public.transaction_submissions SET status_history = jsonb_set(status_history, '{0,reason}', '"x"') WHERE id = %L$q$, v2),
    '~^42501:status_history_append_only$');
  PERFORM pg_temp.expect('E01 agent appends while finalizing',
    format($q$UPDATE public.transaction_submissions SET status = 'resubmitted', status_history = status_history || jsonb_build_array(%L::jsonb) WHERE id = %L$q$,
           shapes[1]::text, v2), '~^42501:status_history_append_only$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(pg_temp.hist(v1) = h1, 'E01 v1 history unchanged');
  PERFORM pg_temp.check(pg_temp.hist(v2) = h2, 'E01 v2 history unchanged');
END
$e01$;
