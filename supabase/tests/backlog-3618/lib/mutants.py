#!/usr/bin/env python3
"""BACKLOG-3618 mutants.

    python3 mutants.py <3618 file> <rollback-3618.sql> <outdir>

Writes <outdir>/<name>.sql (the mutated file) plus .targets, .file
('draft' | 'rollback') and .want ('red' | 'green'). Every edit is an exact
string matched exactly once, or the run aborts. want=green marks a mutant
measured as equivalent: kept in the run so the equivalence stays recorded.
"""
import pathlib
import sys

DRAFT, ROLLBACK, OUT = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])

SEL_OWNER = ("         AND (checklist_templates.owner_user_id IS NULL\n"
             "              OR checklist_templates.owner_user_id = (SELECT auth.uid())));")
ITEM_OWNER = "       AND (t.owner_user_id IS NULL OR t.owner_user_id = (SELECT auth.uid()))\n"
CAN_WRITE_ELSE = "           ELSE p_owner = (SELECT auth.uid()) AND public.can_create_own_checklist_templates(p_org_id)\n"
ADD_HUNK = ("\n     AND (t.owner_user_id IS NULL\n"
            "          OR EXISTS (SELECT 1 FROM public.submission_checklists h0\n"
            "                      WHERE h0.submission_id = p_submission_id AND h0.template_id = t.id))")
SNAP_OWNER = "\n                  AND t.owner_user_id = (SELECT auth.uid())"
SNAP_FLAG = "\n                  AND NOT t.include_in_submission"

# name: (file, find, replace, targets, want)
MUTANTS = {
    # Most likely wrong builds
    "n01-broker-sees-agents-lists": ("draft", SEL_OWNER,
        SEL_OWNER[:-3] + "\n              OR public.can_edit_checklist_templates(checklist_templates.organization_id)));",
        "e04", "red"),
    "n02-peers-see-each-other": ("draft", "\n" + SEL_OWNER, ");", "e03 e16", "red"),
    "n03-item-select-without-owner-term": ("draft", ITEM_OWNER, "", "e03 e04 e16", "green"),
    "n04-editor-writes-any-private": ("draft", CAN_WRITE_ELSE,
        "           ELSE (p_owner = (SELECT auth.uid()) OR public.can_edit_checklist_templates(p_org_id)) AND public.can_create_own_checklist_templates(p_org_id)\n",
        "e08", "red"),
    "n05-write-rule-ignores-owner": ("draft",
        "  SELECT CASE\n           WHEN p_owner IS NULL THEN public.can_edit_checklist_templates(p_org_id)\n" + CAN_WRITE_ELSE + "         END;",
        "  SELECT public.can_edit_checklist_templates(p_org_id) OR public.can_create_own_checklist_templates(p_org_id);",
        "e02", "red"),
    "n06-owner-fk-set-null": ("draft", "REFERENCES auth.users(id) ON DELETE CASCADE", "REFERENCES auth.users(id) ON DELETE SET NULL",
        "e07", "red"),
    "n07-create-own-without-feature": ("draft",
        "              AND m.user_id = (SELECT auth.uid())\n         )\n     AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);",
        "              AND m.user_id = (SELECT auth.uid())\n         );",
        "e05", "red"),
    "n08-add-at-review-no-filter": ("draft", ADD_HUNK, "", "e10", "red"),
    "n09-add-at-review-bare-filter": ("draft", ADD_HUNK, "\n     AND t.owner_user_id IS NULL", "e10", "red"),
    "n10-add-at-review-any-submission": ("draft",
        "WHERE h0.submission_id = p_submission_id AND h0.template_id = t.id", "WHERE h0.template_id = t.id", "e10", "red"),
    "n11-snapshot-no-filter": ("draft",
        "\n    -- BACKLOG-3618: the caller's own template, set not to be sent.\n"
        "    IF EXISTS (SELECT 1 FROM public.checklist_templates t\n"
        "                WHERE t.id = NULLIF(c ->> 'template_id', '')::uuid" + SNAP_OWNER + SNAP_FLAG + ") THEN\n"
        "      CONTINUE;\n    END IF;\n", "", "e11", "red"),
    "n12-snapshot-drops-brokerage": ("draft", SNAP_OWNER + SNAP_FLAG + ") THEN",
        "\n                  AND (t.owner_user_id IS NULL OR (t.owner_user_id = (SELECT auth.uid())" + SNAP_FLAG + "))) THEN",
        "e11", "red"),
    "n13-snapshot-drops-every-own": ("draft", SNAP_FLAG + ") THEN", ") THEN", "e11", "red"),
    "n14-snapshot-without-owner-term": ("draft", SNAP_OWNER + SNAP_FLAG, SNAP_FLAG, "e11", "green"),
    "n15-check-dropped": ("draft", "CHECK (owner_user_id IS NOT NULL OR include_in_submission)", "CHECK (true)", "e09", "red"),
    "n16-save-scope-from-argument": ("draft",
        "    IF NOT public.can_write_checklist_template(p_org_id, v_owner) THEN",
        "    IF NOT public.can_write_checklist_template(p_org_id, CASE WHEN p_personal THEN (SELECT auth.uid()) END) THEN",
        "e06", "red"),
    "n17-save-omitted-switch-resets": ("draft", "COALESCE(p_include_in_submission, t.include_in_submission)",
        "COALESCE(p_include_in_submission, true)", "e06", "red"),
    "n18-save-brokerage-excludable-guard-gone": ("draft",
        "  IF v_owner IS NULL AND p_include_in_submission IS FALSE THEN", "  IF false THEN", "e06", "red"),
    "n19-owner-column-updatable": ("draft", "GRANT UPDATE (include_in_submission) ON", "GRANT UPDATE (include_in_submission, owner_user_id) ON",
        "e02 e15", "red"),
    "n20-save-personal-never-owned": ("draft", "    v_owner := CASE WHEN COALESCE(p_personal, false) THEN (SELECT auth.uid()) END;",
        "    v_owner := NULL;", "e06", "red"),
    "n21-item-insert-editor-only": ("draft",
        "       AND public.can_write_checklist_template(t.organization_id, t.owner_user_id)\n  ));\n\nDROP POLICY IF EXISTS checklist_template_items_update_editor",
        "       AND public.can_edit_checklist_templates(t.organization_id)\n  ));\n\nDROP POLICY IF EXISTS checklist_template_items_update_editor",
        "e01", "red"),
    # Drift outside the hunks: e12 must see it
    "n22-snapshot-body-drift": ("draft", "    n_checklists := n_checklists + 1;", "    n_checklists := n_checklists + 1 ;", "e12", "red"),
    "n23-add-body-drift": ("draft", "    RETURN jsonb_build_object('status', 'template_not_found');",
        "    RETURN jsonb_build_object('status', 'template_not_found' );", "e12", "red"),
    # Rollback
    "n24-rollback-keeps-private-rows": ("rollback", "DELETE FROM public.checklist_templates WHERE owner_user_id IS NOT NULL;\n", "",
        "e13", "red"),
    "n25-rollback-leaves-new-save": ("rollback",
        "DROP FUNCTION IF EXISTS public.save_checklist_template(uuid, uuid, text, text, text, jsonb, boolean, boolean);\n", "",
        "e13", "red"),
    # SR review (pm_comments a3493296), C11/C12
    "s1-select-drops-org-term": ("draft",
        "  USING (checklist_templates.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid())))\n"
        "         AND (checklist_templates.owner_user_id IS NULL\n",
        "  USING ((checklist_templates.owner_user_id IS NULL\n",
        "e03", "red"),
    "s3-rollback-deletes-only-excluded": ("rollback",
        "DELETE FROM public.checklist_templates WHERE owner_user_id IS NOT NULL;\n",
        "DELETE FROM public.checklist_templates WHERE owner_user_id IS NOT NULL AND NOT include_in_submission;\n",
        "e13", "red"),
}

OUT.mkdir(parents=True, exist_ok=True)
src = {"draft": DRAFT.read_text(), "rollback": ROLLBACK.read_text()}
for name, (kind, find, repl, targets, want) in MUTANTS.items():
    text = src[kind]
    n = text.count(find)
    if n != 1:
        sys.exit(f"{name}: pattern matched {n} times in {kind}, expected exactly 1")
    out = text.replace(find, repl, 1)
    if out == text:
        sys.exit(f"{name}: MUTATION NOT APPLIED")
    (OUT / f"{name}.sql").write_text(out)
    (OUT / f"{name}.targets").write_text(targets)
    (OUT / f"{name}.file").write_text(kind)
    (OUT / f"{name}.want").write_text(want)
print(f"mutants.py: {len(MUTANTS)} written")
