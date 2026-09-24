-- BACKLOG-3474: who last edited, and who archived, each checklist template.
--
-- Adds two columns to checklist_templates and one trigger that fills them:
--
--   updated_by   the user whose change last moved updated_at. Set on EVERY
--                UPDATE of the row: a save through save_checklist_template
--                (which updates the template row on every save, item-only
--                saves included) and an archive or restore (which also moves
--                updated_at). NULL on insert: a template nobody has edited
--                has no last editor. NULL after an UPDATE with no signed-in
--                user (service role, SQL).
--   archived_by  the user who archived the template. Set when archived_at goes
--                from NULL to a value, kept while it stays archived, cleared
--                when archived_at goes back to NULL (restore).
--
-- created_by / created_at / updated_at / archived_at already exist.
--
-- Clients cannot write either column: neither is in the table's INSERT or
-- UPDATE column grants, so a request naming one is refused with 42501. The
-- trigger ignores whatever a privileged writer sends and uses auth.uid().
-- The trigger decides no authority: who may update the row is still RLS
-- (can_edit_checklist_templates) and save_checklist_template's own check.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS checklist_templates_audit ON public.checklist_templates;
--   DROP FUNCTION IF EXISTS public._checklist_templates_audit();
--   ALTER TABLE public.checklist_templates DROP COLUMN IF EXISTS archived_by,
--                                          DROP COLUMN IF EXISTS updated_by;

ALTER TABLE public.checklist_templates
  ADD COLUMN IF NOT EXISTS updated_by uuid NULL
    CONSTRAINT checklist_templates_updated_by_fkey REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_by uuid NULL
    CONSTRAINT checklist_templates_archived_by_fkey REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public._checklist_templates_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  IF NEW.archived_at IS NULL THEN
    NEW.archived_by := NULL;
  ELSIF OLD.archived_at IS NULL THEN
    NEW.archived_by := auth.uid();
  ELSE
    NEW.archived_by := OLD.archived_by;
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public._checklist_templates_audit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER checklist_templates_audit
  BEFORE UPDATE ON public.checklist_templates
  FOR EACH ROW
  EXECUTE FUNCTION public._checklist_templates_audit();
