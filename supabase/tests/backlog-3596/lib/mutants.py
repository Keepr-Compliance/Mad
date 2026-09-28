#!/usr/bin/env python3
"""BACKLOG-3596 mutants. Each is the shipped migration (or rollback.sql) with
ONE targeted change, made by an exact string replacement that must match
exactly once -- otherwise the run aborts (MUTATION NOT APPLIED).

    python3 mutants.py <migration> <rollback> <outdir>

writes <outdir>/<name>.sql, .targets (controls that must go RED) and .file
('migration' or 'rollback'). run.sh does the rest.
"""
import pathlib
import sys

MUTANTS = [
    # --- the likeliest wrong builds (named in the brief / SR review) ---------
    ("m01-restamp-by-with-caller", "c01 c09", "migration",
     "               reviewer_checked_by = r.reviewer_checked_by,",
     "               reviewer_checked_by = v_uid,"),
    ("m02-restamp-at-with-now", "c01 c09", "migration",
     "               reviewer_checked_at = r.reviewer_checked_at\n         WHERE id = r.new_item_id;",
     "               reviewer_checked_at = v_now\n         WHERE id = r.new_item_id;"),
    ("m03-compare-cloud-row-ids", "c01 c04", "migration",
     "               COALESCE(a.local_attachment_id, m.local_message_id) AS local_id",
     "               COALESCE(lm.submission_attachment_id, lm.submission_message_id)::text AS local_id"),
    ("m04-carry-from-grandparent", "c16", "migration",
     "         WHERE pi.submission_id = v_parent.id\n           AND pi.reviewer_checked\n           AND pi.local_item_id IS NOT NULL",
     "         WHERE pi.submission_id = COALESCE((SELECT g.parent_submission_id FROM public.transaction_submissions g WHERE g.id = v_parent.id), v_parent.id)\n           AND pi.reviewer_checked\n           AND pi.local_item_id IS NOT NULL"),
    ("m05-tick-no-superseded-check", "c14", "migration",
     "  IF EXISTS (SELECT 1 FROM public.transaction_submissions c\n              WHERE c.parent_submission_id = v_row.submission_id) THEN",
     "  IF false THEN"),
    ("m06-superseded-ignores-uploading", "c14", "migration",
     "              WHERE c.parent_submission_id = v_row.submission_id) THEN",
     "              WHERE c.parent_submission_id = v_row.submission_id AND c.status <> 'uploading') THEN"),
    ("m07-system-actor", "c02", "migration",
     "          'reason', 'edited',",
     "          'reason', 'edited',\n          'system', true,\n          'changed_by', '00000000-0000-0000-0000-000000000000',"),
    ("m08-carry-before-inserts", "c01", "migration",
     "  -- Last: every item and link member of this version exists by now.\n  v_carry := public.carry_submission_checklist_reviews(p_submission_id);\n",
     ""),
    # m08 moves the call: see m08b below for the insertion point.
    # --- parent rules --------------------------------------------------------
    ("m09-parent-any-submitter", "c17", "migration",
     "     OR v_parent.submitted_by IS DISTINCT FROM v_sub.submitted_by\n", ""),
    ("m10-parent-any-version", "c17", "migration",
     "     OR v_parent.version <> v_sub.version - 1 THEN", "     THEN"),
    ("m11-parent-any-deal", "c17", "migration",
     "     OR v_parent.local_transaction_id IS DISTINCT FROM v_sub.local_transaction_id\n", ""),
    # --- match keys and comparison ------------------------------------------
    ("m12-match-ignores-title", "c13", "migration",
     "           AND ni.title = pi.title\n", ""),
    ("m13-match-ignores-template", "c13", "migration",
     "           AND nh.template_id IS NOT DISTINCT FROM ph.template_id\n", ""),
    ("m14-note-compared-raw", "c04", "migration",
     "NULLIF(btrim(p.new_note), '') IS DISTINCT FROM NULLIF(btrim(p.parent_note), '')",
     "p.new_note IS DISTINCT FROM p.parent_note"),
    ("m15-changed-still-carries", "c02", "migration",
     "      ELSIF NOT r.changed THEN", "      ELSIF true THEN"),
    ("m16-changed-no-marker", "c02", "migration",
     "           SET cleared_reviewer_id = r.reviewer_checked_by,\n               cleared_at          = v_now\n",
     "           SET cleared_reviewer_id = NULL,\n               cleared_at          = NULL\n"),
    ("m17-marker-on-unticked-items", "c03", "migration",
     "         WHERE pi.submission_id = v_parent.id\n           AND pi.reviewer_checked\n",
     "         WHERE pi.submission_id = v_parent.id\n"),
    ("m18-evidence-one-direction", "c04", "migration",
     "                OR EXISTS (SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.new_item_id\n                           EXCEPT\n                           SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.parent_item_id)\n",
     ""),
    # --- D3 / D5 / old client / no copy -------------------------------------
    ("m19-legacy-rows-get-lines", "c18", "migration",
     "           AND pi.reviewer_checked\n           AND pi.local_item_id IS NOT NULL\n",
     "           AND pi.reviewer_checked\n"),
    ("m20-no-old-client-branch", "c18", "migration",
     "  ELSIF v_items > 0 AND v_with_ids = 0 THEN", "  ELSIF false THEN"),
    ("m21-no-copy-without-ancestor-term", "c19", "migration",
     "       WHERE c.id <> v_parent.id\n         AND ai.reviewer_checked\n    ) THEN",
     "       WHERE true\n    ) OR true THEN"),
    ("m22-no-copy-silent", "c19", "migration",
     "      v_unavailable := 'no_previous_copy';", "      NULL;"),
    ("m23-unavailable-twice", "c06", "migration",
     "  IF v_unavailable IS NOT NULL\n     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sub.history) AS h(e)\n                      WHERE h.e ->> 'type' = 'checklist_review_unavailable') THEN",
     "  IF v_unavailable IS NOT NULL THEN"),
    ("m24-removed-twice", "c06", "migration",
     "      CONTINUE WHEN EXISTS (", "      CONTINUE WHEN false AND EXISTS ("),
    ("m25-removed-silent", "c13", "migration",
     "      IF r.new_item_id IS NULL THEN", "      IF r.new_item_id IS NULL AND false THEN"),
    # --- carry's own checks ---------------------------------------------------
    ("m26-carry-any-caller", "c05", "migration",
     "  IF NOT FOUND OR v_sub.submitted_by IS DISTINCT FROM v_uid OR v_sub.status IS DISTINCT FROM 'uploading' THEN",
     "  IF NOT FOUND OR v_sub.status IS DISTINCT FROM 'uploading' THEN"),
    ("m27-carry-any-status", "c05", "migration",
     "  IF NOT FOUND OR v_sub.submitted_by IS DISTINCT FROM v_uid OR v_sub.status IS DISTINCT FROM 'uploading' THEN",
     "  IF NOT FOUND OR v_sub.submitted_by IS DISTINCT FROM v_uid THEN"),
    ("m28-carry-no-feature-check", "c05", "migration",
     "  IF NOT COALESCE((public.check_feature_access(v_sub.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN\n    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';\n  END IF;\n\n  IF v_sub.parent_submission_id IS NULL THEN",
     "  IF v_sub.parent_submission_id IS NULL THEN"),
    ("m29-carry-anon-grant", "c05 c15", "migration",
     "GRANT EXECUTE ON FUNCTION public.carry_submission_checklist_reviews(uuid) TO authenticated;",
     "GRANT EXECUTE ON FUNCTION public.carry_submission_checklist_reviews(uuid) TO anon, authenticated;"),
    ("m30-snapshot-security-definer", "c15", "migration",
     "RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = ''",
     "RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''"),
    ("m31-carry-invoker", "c01 c15", "migration",
     "  p_submission_id uuid\n)\nRETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER",
     "  p_submission_id uuid\n)\nRETURNS jsonb\nLANGUAGE plpgsql\nSECURITY INVOKER"),
    ("m32-snapshot-drops-local-item-id", "c01", "migration",
     "              NULLIF(it ->> 'local_item_id', ''),", "              NULL,"),
    ("m33-insert-allows-cleared", "c12", "migration",
     "    AND submission_checklist_items.cleared_reviewer_id IS NULL\n    AND submission_checklist_items.cleared_at IS NULL\n",
     ""),
    ("m34-superseded-before-authorization", "c14", "migration",
     "  IF NOT FOUND OR NOT public.can_review_submission(v_row.organization_id) THEN\n    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';\n  END IF;\n  IF NOT COALESCE((public.check_feature_access(v_row.organization_id",
     "  IF FOUND AND EXISTS (SELECT 1 FROM public.transaction_submissions c WHERE c.parent_submission_id = v_row.submission_id) THEN\n    RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';\n  END IF;\n  IF NOT FOUND OR NOT public.can_review_submission(v_row.organization_id) THEN\n    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';\n  END IF;\n  IF NOT COALESCE((public.check_feature_access(v_row.organization_id"),
    # --- BACKLOG-3592 UPDATE rule ---------------------------------------------
    ("m35-update-rule-unchanged", "c20", "migration",
     "    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))\n        AND (organization_id IN",
     "    OR (true\n        AND (organization_id IN"),
    ("m36-update-status-filter-in-with-check", "c20", "migration",
     "    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))\n        AND (organization_id IN",
     "    OR (true\n        AND (organization_id IN"),
    ("m37-update-filter-on-submitter-too", "c20", "migration",
     "  USING (\n    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])))\n    OR (",
     "  USING (\n    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])) AND ((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text])))\n    OR ("),
    ("m38-update-rule-adds-it-admin", "c20", "migration",
     "  USING (\n    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])))\n    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))\n        AND (organization_id IN ( SELECT organization_members.organization_id\n           FROM organization_members\n          WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))",
     "  USING (\n    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])))\n    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))\n        AND (organization_id IN ( SELECT organization_members.organization_id\n           FROM organization_members\n          WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY['broker'::text, 'admin'::text, 'it_admin'::text]))))))"),
    # --- file hygiene --------------------------------------------------------
    ("m39-constraint-added-unguarded", "c21", "migration",
     "DO $constraints$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint\n                  WHERE conname = 'submission_checklist_items_cleared_pair_check'\n                    AND conrelid = 'public.submission_checklist_items'::regclass) THEN\n    ALTER TABLE public.submission_checklist_items\n      ADD CONSTRAINT submission_checklist_items_cleared_pair_check\n      CHECK ((cleared_reviewer_id IS NULL) = (cleared_at IS NULL));\n  END IF;\nEND\n$constraints$;",
     "ALTER TABLE public.submission_checklist_items\n  ADD CONSTRAINT submission_checklist_items_cleared_pair_check\n  CHECK ((cleared_reviewer_id IS NULL) = (cleared_at IS NULL));"),
    # --- rollback.sql ---------------------------------------------------------
    ("m40-rollback-keeps-superseded-tick", "c22", "rollback",
     "  IF v_row.added_at_review_by IS NOT NULL THEN\n    RAISE EXCEPTION 'added_at_review' USING ERRCODE = '42501';\n  END IF;\n",
     "  IF v_row.added_at_review_by IS NOT NULL THEN\n    RAISE EXCEPTION 'added_at_review' USING ERRCODE = '42501';\n  END IF;\n  IF EXISTS (SELECT 1 FROM public.transaction_submissions c\n              WHERE c.parent_submission_id = v_row.submission_id) THEN\n    RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';\n  END IF;\n"),
    ("m41-rollback-keeps-update-rule", "c22", "rollback",
     "    OR (organization_id IN ( SELECT organization_members.organization_id\n       FROM organization_members\n      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))\n  )\n  WITH CHECK (",
     "    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text])) AND (organization_id IN ( SELECT organization_members.organization_id\n       FROM organization_members\n      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))\n  )\n  WITH CHECK ("),
    ("m42-rollback-keeps-carry", "c22", "rollback",
     "DROP FUNCTION IF EXISTS public.carry_submission_checklist_reviews(uuid);\n", ""),
]

# m08 is a MOVE: drop the call at the end (above) and put it before the loop.
MOVES = {
    "m08-carry-before-inserts": (
        "  FOR c IN SELECT e.value FROM jsonb_array_elements(p_checklists) AS e(value) LOOP\n    IF jsonb_typeof(c) <> 'object'",
        "  v_carry := public.carry_submission_checklist_reviews(p_submission_id);\n  FOR c IN SELECT e.value FROM jsonb_array_elements(p_checklists) AS e(value) LOOP\n    IF jsonb_typeof(c) <> 'object'"),
}

# m17 marks every changed item, ticked or not. The cleared-by value is
# COALESCEd so the pair CHECK holds and c03's own assertions are what see it
# (a bare removal of the reviewer_checked term reds c03 only via the CHECK).
MOVES["m17-marker-on-unticked-items"] = (
    "           SET cleared_reviewer_id = r.reviewer_checked_by,",
    "           SET cleared_reviewer_id = COALESCE(r.reviewer_checked_by, v_uid),")

# m36 puts the filter in WITH CHECK instead of USING: remove from USING
# (above), then add to the reviewer branch of WITH CHECK.
MOVES["m36-update-status-filter-in-with-check"] = (
    "    OR (organization_id IN ( SELECT organization_members.organization_id\n       FROM organization_members\n      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))\n  );",
    "    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text])) AND (organization_id IN ( SELECT organization_members.organization_id\n       FROM organization_members\n      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))\n  );")


def once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f"{label}: MUTATION NOT APPLIED (old text matched {n} times)")
    return text.replace(old, new, 1)


def main():
    mig = pathlib.Path(sys.argv[1]).read_text()
    rb = pathlib.Path(sys.argv[2]).read_text()
    out = pathlib.Path(sys.argv[3])
    names = [m[0] for m in MUTANTS]
    if len(set(names)) != len(names):
        sys.exit("duplicate mutant name")
    for name, targets, kind, old, new in MUTANTS:
        src = mig if kind == "migration" else rb
        text = once(src, old, new, name)
        if name in MOVES:
            text = once(text, *MOVES[name], label=name + " (move)")
        (out / f"{name}.sql").write_text(text)
        (out / f"{name}.targets").write_text(targets)
        (out / f"{name}.file").write_text(kind)
    print(f"mutants.py: {len(MUTANTS)} mutants written")


if __name__ == "__main__":
    main()
