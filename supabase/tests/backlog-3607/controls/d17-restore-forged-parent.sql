-- D17 (SR R-1): restore qualifies the DIRECT parent, not just its id.
-- An agent can append a typed history entry to its own uploading version
-- (the append-only guard admits it; SR probe d99 measured rows=1), so a
-- forged checklist_removed {source: 'version'} entry passes the removal-
-- record check. Only the parent qualification (same organization, deal,
-- submitter, version n - 1) then stands between the forged version and a
-- restore. Four versions, each differing from the reviewed v1 in ONE of
-- those four, each pointing parent_submission_id at a parent that holds the
-- source header, each with a forged removal entry for that header's key:
--   (a) a colleague's version 2 (another submitter),
--   (b) this agent's version 2 in T1 whose parent is this agent's version 1
--       in ANOTHER organization (T2),
--   (c) this agent's version 3 pointing at version 1 (a version skipped),
--   (d) this agent's version 2 of ANOTHER deal pointing at this deal's v1.
-- All -> 42501 not_authorized; nothing restored, no history entry.
-- (b)'s T2 parent and its header are owner inserts: T2 has no checklist
-- feature, so the snapshot RPC cannot write them. The header's existence is
-- not the point; the parent's organization is.
SET LOCAL check_function_bodies = off;
CREATE FUNCTION pg_temp.forge_removed(p_sub uuid, p_uid uuid, p_key text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE how text;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  BEGIN
    UPDATE public.transaction_submissions
       SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'type', 'checklist_removed', 'source', 'version', 'changed_by', p_uid, 'checklist_key', p_key))
     WHERE id = p_sub;
    how := 'agent';
  EXCEPTION WHEN OTHERS THEN how := NULL;
  END;
  PERFORM pg_temp.act_owner();
  IF how IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.hist(p_sub)) e
                                 WHERE e ->> 'type' = 'checklist_removed' AND e ->> 'checklist_key' = p_key) THEN
    -- keep the restore's history check exercised even if agents lose this
    UPDATE public.transaction_submissions
       SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'type', 'checklist_removed', 'source', 'version', 'changed_by', p_uid, 'checklist_key', p_key))
     WHERE id = p_sub;
    how := 'owner';
  END IF;
  RETURN how;
END
$$;

-- refused(label, version, source): restore as the broker -> not_authorized,
-- and nothing written on the version.
CREATE FUNCTION pg_temp.d17_refused(p_label text, p_sub uuid, p_src uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE n integer := jsonb_array_length(pg_temp.hist(p_sub));
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_broker'));
  PERFORM pg_temp.expect('D17 ' || p_label,
    format('SELECT public.restore_submission_checklist_at_review(%L, %L)', p_sub, p_src), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_checklists WHERE submission_id = p_sub)
                        AND jsonb_array_length(pg_temp.hist(p_sub)) = n,
                        'D17 ' || p_label || ': nothing written');
END
$$;
SET LOCAL check_function_bodies = on;

DO $d17$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  agent2 uuid := pg_temp.id('u_t1_agent2');
  key_a  text := pg_temp.id('tpl_t1_a')::text;
  v1 uuid; src uuid; s uuid; t2p uuid; t2h uuid; how text;
BEGIN
  v1  := pg_temp.build_v1('fixture-3607-d17');
  src := pg_temp.hdr(v1, 'Fixture starter A');

  -- (a) a colleague's version 2 of the same deal
  s := pg_temp.new_version(v1, 2, NULL, agent2);
  how := pg_temp.forge_removed(s, agent2, key_a);
  RAISE NOTICE 'D17 (a) removal entry forged by: %', how;
  PERFORM pg_temp.set_status(s, 'resubmitted');
  PERFORM pg_temp.d17_refused('(a) another submitter', s, src);

  -- (b) parent in another organization (same agent, deal, version 1)
  t2p := pg_temp.mk_sub('fixture-3607-d17-b', 1, NULL, 'needs_changes', agent, pg_temp.id('o_t2'));
  INSERT INTO public.submission_checklists (submission_id, template_id, template_name, sort_order)
  VALUES (t2p, NULL, 'Fixture other org', 0)
  RETURNING id INTO t2h;
  s := pg_temp.mk_sub('fixture-3607-d17-b', 2, t2p, 'uploading', agent, pg_temp.id('o_t1'));
  how := pg_temp.forge_removed(s, agent, 'name:Fixture other org');
  RAISE NOTICE 'D17 (b) removal entry forged by: %', how;
  PERFORM pg_temp.set_status(s, 'resubmitted');
  PERFORM pg_temp.d17_refused('(b) parent in another organization', s, t2h);

  -- (c) version 3 pointing at version 1
  s := pg_temp.new_version(v1, 3);
  how := pg_temp.forge_removed(s, agent, key_a);
  RAISE NOTICE 'D17 (c) removal entry forged by: %', how;
  PERFORM pg_temp.set_status(s, 'resubmitted');
  PERFORM pg_temp.d17_refused('(c) a version skipped', s, src);

  -- (d) version 2 of another deal pointing at this deal's version 1
  s := pg_temp.new_version(v1, 2, NULL, NULL, 'fixture-3607-d17-other-deal');
  how := pg_temp.forge_removed(s, agent, key_a);
  RAISE NOTICE 'D17 (d) removal entry forged by: %', how;
  PERFORM pg_temp.set_status(s, 'resubmitted');
  PERFORM pg_temp.d17_refused('(d) another deal', s, src);

  -- positive control: the same forged entry on the REAL version 2 of this
  -- deal restores (the refusals above are the parent check, nothing else).
  s := pg_temp.new_version(v1, 2);
  how := pg_temp.forge_removed(s, agent, key_a);
  PERFORM pg_temp.set_status(s, 'resubmitted');
  PERFORM pg_temp.check(pg_temp.restore_as(pg_temp.id('u_t1_broker'), s, src) ->> 'status' = 'restored',
                        'D17 positive: the qualified parent restores');
END
$d17$;
