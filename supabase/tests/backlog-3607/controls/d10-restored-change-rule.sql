-- D10 (C-4.5): a restored item's "changed since you checked" baseline is its
-- SOURCE item (note + evidence by local id), never the empty restored row.
--   v1 A reviewed -> v2 without A -> broker restores A on v2 -> needs_changes
--   -> v3 carries the pulled A (local ids = v2's restored cloud ids).
--   (a) the agent re-links the SAME documents and note as on v1 -> the 4
--       restored ticks carry, nothing cleared (a restored-row baseline would
--       clear all 4 as 'edited').
--   (b) the agent links nothing -> the 4 ticks are cleared 'edited' (a
--       restored-row baseline would carry ticks whose evidence is gone).
CREATE FUNCTION pg_temp.d10_v3(p_txn text, p_relink boolean) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; v3 uuid; res jsonb; hdr2 uuid; p jsonb; items jsonb := '[]'::jsonb; it jsonb; bi jsonb;
BEGIN
  v2 := pg_temp.rm_v2(p_txn);
  v1 := (SELECT parent_submission_id FROM public.transaction_submissions WHERE id = v2);
  res := pg_temp.restore_as(broker, v2, pg_temp.hdr(v1, 'Fixture starter A'));
  hdr2 := (res ->> 'checklist_id')::uuid;
  PERFORM pg_temp.set_status(v2, 'needs_changes');
  v3 := pg_temp.new_version(v2, 3);
  p := pg_temp.pulled(hdr2);
  IF p_relink THEN
    FOR it IN SELECT value FROM jsonb_array_elements(p -> 0 -> 'items') LOOP
      SELECT b INTO bi FROM jsonb_array_elements(pg_temp.base_payload() -> 0 -> 'items') b WHERE b ->> 'title' = it ->> 'title';
      items := items || jsonb_build_array(it || jsonb_build_object('note', bi -> 'note', 'links', COALESCE(bi -> 'links', '[]'::jsonb)));
    END LOOP;
    p := jsonb_set(p, '{0,items}', items);
  END IF;
  res := pg_temp.snap_as(pg_temp.id('u_t1_agent'), v3, pg_temp.pb() || p);
  RETURN res -> 'carry';
END
$$;

DO $d10$
DECLARE c jsonb;
BEGIN
  c := pg_temp.d10_v3('fixture-3607-d10a', true);
  PERFORM pg_temp.check((c ->> 'carried')::int = 5 AND (c ->> 'cleared')::int = 0 AND (c ->> 'removed')::int = 0,
                        'D10a same evidence as the source -> carried: ' || c::text);
  c := pg_temp.d10_v3('fixture-3607-d10b', false);
  PERFORM pg_temp.check((c ->> 'carried')::int = 1 AND (c ->> 'cleared')::int = 4,
                        'D10b evidence gone -> cleared: ' || c::text);
END
$d10$;
