-- BACKLOG-4259: the test project now has the real BACKLOG-4236 public.get_my_cloud_autosave_state().
-- controls.sql creates its own stub of that function (D15), so the real one is renamed for the
-- length of this transaction; the call ends in RAISE, so the rename is rolled back with everything else.
DO $pre4259$
BEGIN
  IF to_regprocedure('public.get_my_cloud_autosave_state()') IS NOT NULL THEN
    ALTER FUNCTION public.get_my_cloud_autosave_state() RENAME TO get_my_cloud_autosave_state_p4259_hidden;
  END IF;
END
$pre4259$;
