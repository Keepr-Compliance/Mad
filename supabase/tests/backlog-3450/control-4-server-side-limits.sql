-- BACKLOG-3450 / CONTROL 4 — the limits the browser cannot be trusted with
--
-- Three properties, all enforced in `report_save_view`:
--   a. the SIXTH pinned card is refused. Two tabs defeat a client-side cap.
--   b. re-saving an already-pinned card does NOT count itself against the cap.
--   c. a `p_id` that matches no row RAISES — it never inserts under an id the
--      caller chose — and another user cannot update the owner's row.
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v owner="'<uuid-1>'" -v other="'<uuid-2>'" \
--     -f control-4-server-side-limits.sql

\set ON_ERROR_STOP on
BEGIN;

DO $control$
DECLARE
  k_owner CONSTANT UUID := :owner;
  k_other CONSTANT UUID := :other;
  k_filters CONSTANT JSONB :=
    '{"types":[],"outcomes":[],"platforms":[],"search":"","stalledOnly":false}'::jsonb;
  k_metric CONSTANT JSONB := '{"col":"runs","fn":"count"}'::jsonb;
  k_absent CONSTANT UUID := '00000000-0000-4000-8000-000000345001'; -- pii-allow-uuid: invented id, asserted absent below
  v_first UUID;
  v_id UUID;
  v_message TEXT;
  v_refused BOOLEAN;
BEGIN
  ASSERT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = k_owner),
    'CONTROL 4: :owner has no internal_roles row';
  ASSERT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = k_other),
    'CONTROL 4: :other has no internal_roles row';
  ASSERT NOT EXISTS (SELECT 1 FROM report_saved_views WHERE id = k_absent),
    'CONTROL 4: the invented id is not absent after all — pick another';

  PERFORM set_config('request.jwt.claim.sub', k_owner::text, true);

  -- Start from a clean slate for this report, inside the transaction.
  DELETE FROM report_saved_views WHERE user_id = k_owner AND report_key = 'control-4';

  -- (a) five pins succeed, the sixth is refused.
  FOR i IN 1..5 LOOP
    v_id := (public.report_save_view(
      'control-4', format('CONTROL 4 pin %s', i), k_filters, k_metric, true, NULL
    )->>'id')::uuid;
    IF i = 1 THEN v_first := v_id; END IF;
  END LOOP;
  RAISE NOTICE 'PASS (a1): five pins accepted';

  v_refused := false;
  BEGIN
    PERFORM public.report_save_view('control-4', 'CONTROL 4 pin 6', k_filters, k_metric, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    v_refused := v_message LIKE 'At most 5 pinned%';
  END;
  ASSERT v_refused, 'CONTROL 4 FAILED (a): the database accepted a SIXTH pinned card';
  RAISE NOTICE 'PASS (a2): the sixth pin was refused — %', v_message;

  -- An unpinned sixth view is fine; the cap is on cards, not on views.
  PERFORM public.report_save_view('control-4', 'CONTROL 4 unpinned', k_filters, k_metric, false, NULL);
  RAISE NOTICE 'PASS (a3): an UNPINNED sixth view is still accepted';

  -- (b) re-saving an already-pinned card must not refuse itself.
  PERFORM public.report_save_view(
    'control-4', 'CONTROL 4 pin 1 renamed', k_filters, k_metric, true, v_first
  );
  ASSERT (SELECT name FROM report_saved_views WHERE id = v_first) = 'CONTROL 4 pin 1 renamed',
    'CONTROL 4 FAILED (b): the rename did not take';
  ASSERT (SELECT count(*) FROM report_saved_views
          WHERE user_id = k_owner AND report_key = 'control-4' AND pinned) = 5,
    'CONTROL 4 FAILED (b): re-saving a pinned card changed the pinned count';
  RAISE NOTICE 'PASS (b): an already-pinned card can be re-saved, and keeps its id';

  -- (c1) a p_id matching no row RAISES rather than inserting under it.
  v_refused := false;
  BEGIN
    PERFORM public.report_save_view('control-4', 'CONTROL 4 ghost', k_filters, k_metric, false, k_absent);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    v_refused := v_message LIKE 'Saved view not found%';
  END;
  ASSERT v_refused, 'CONTROL 4 FAILED (c1): an unknown p_id did not raise';
  ASSERT NOT EXISTS (SELECT 1 FROM report_saved_views WHERE id = k_absent),
    'CONTROL 4 FAILED (c1): a row was INSERTED under a caller-chosen id';
  RAISE NOTICE 'PASS (c1): an unknown p_id raised and inserted nothing';

  -- (c2) another internal user cannot update the owner's row.
  PERFORM set_config('request.jwt.claim.sub', k_other::text, true);
  v_refused := false;
  BEGIN
    PERFORM public.report_save_view('control-4', 'stolen', k_filters, k_metric, false, v_first);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    v_refused := v_message LIKE 'Only the view owner%';
  END;
  ASSERT v_refused, 'CONTROL 4 FAILED (c2): another internal user UPDATED the owner''s view';
  ASSERT (SELECT name FROM report_saved_views WHERE id = v_first) = 'CONTROL 4 pin 1 renamed',
    'CONTROL 4 FAILED (c2): the owner''s row was changed anyway';
  RAISE NOTICE 'PASS (c2): the update was refused — %', v_message;

  RAISE NOTICE 'CONTROL 4 PASSED';
END
$control$;

ROLLBACK;
