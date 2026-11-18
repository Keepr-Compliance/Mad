-- Real answers of the write tools and of the reader, recorded for the portal's fixtures (after every control and
-- mutation; ids are replaced by <id:n> when the fixture file is written). The switch is on for this block only.
DO $obs5$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  PERFORM pg_temp.rec('FX_update_applied', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('t1'), '{"done":true}')));
  PERFORM pg_temp.rec('FX_update_unchanged', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('t1'), '{"done":true}')));
  PERFORM pg_temp.rec('FX_update_not_allowed', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('t1'), '{"title":"Renamed"}')));
  PERFORM pg_temp.rec('FX_update_locked', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('l1'), '{"done":true}')));
  PERFORM pg_temp.rec('FX_update_note_was_shortened', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m3'), '{"note":"short"}')));
  PERFORM pg_temp.rec('FX_update_is_removed', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m4'), '{"done":true}')));
  PERFORM pg_temp.rec('FX_add_added', pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA1'), 'Book the movers', 'Two trucks', '2026-12-20', 'fx-add-1')));
  PERFORM pg_temp.rec('FX_add_already_added', pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA1'), 'Book the movers')));
  PERFORM pg_temp.rec('FX_remove_removed', pg_temp.w(pg_temp.q_rm(11, pg_temp.id('m2'))));
  PERFORM pg_temp.rec('FX_remove_not_allowed', pg_temp.w(pg_temp.q_rm(11, pg_temp.id('t1'))));
  PERFORM pg_temp.rec('FX_restore_restored', pg_temp.w(pg_temp.q_rs(11, pg_temp.id('m2'))));
  PERFORM pg_temp.rec('FX_restore_not_removed', pg_temp.w(pg_temp.q_rs(11, pg_temp.id('m2'))));
  PERFORM pg_temp.rec('FX_err_read_only', pg_temp.w(pg_temp.q_upd(1, pg_temp.id('m1'), '{"done":true}')));
  PERFORM pg_temp.rec('FX_err_not_found', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('b1'), '{"done":true}')));
  PERFORM pg_temp.rec('FX_err_invalid_input', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{}')));
  PERFORM pg_temp.rec('FX_write_access_on', pg_temp.w(pg_temp.q_wa(11)));
  PERFORM pg_temp.rec('FX_write_access_read_grant', pg_temp.w(pg_temp.q_wa(1)));
  PERFORM pg_temp.rec('FX_checklists_v2', pg_temp.w(pg_temp.q_cl(11, pg_temp.id('DA1'))));
  PERFORM pg_temp.sw(false);
  PERFORM pg_temp.rec('FX_checklists_v1', pg_temp.w(pg_temp.q_cl(11, pg_temp.id('DA1'))));
  PERFORM pg_temp.rec('FX_write_access_off', pg_temp.w(pg_temp.q_wa(11)));
  PERFORM pg_temp.rec('FX_update_switch_off', pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true}')));
END
$obs5$;
