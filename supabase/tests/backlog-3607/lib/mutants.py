#!/usr/bin/env python3
"""BACKLOG-3607 mutants (DRAFT, plan rev 2 pre-runs).

    python3 mutants.py <draft> <draft-rollback> <3596 refusals> <3596 added> <outdir>

Two sets:
  PORTED (SR C-5): every backlog-3596 mutant of kind 'added' or 'refusals'.
    The 3607 file re-creates the tick, the carry and the add bodies, so a
    mutant of those bodies in a 3596 file edits code that no longer runs. Each
    is ported to kind 'draft' when its text matches the draft exactly once
    (MOVES too); one that matches the draft 0 times and whose body the draft
    does NOT re-create keeps its 3596 kind (m45: a trigger). Anything else is
    listed as NEEDS REWRITE and the run aborts.
  NEW: the 3607 code.
Every edit is exact-string, matched exactly once, or the run aborts.
"""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("m3596", HERE.parent.parent / "backlog-3596" / "lib" / "mutants.py")
m3596 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m3596)

# Rewritten ports: the draft changed the matched text on purpose.
REWRITES = {
    # the feature check now returns quietly for an empty snapshot first; the
    # 3607 control that sees it is d02 (feature off, [] -> not_in_plan, not
    # no_parent). Targets handled in TARGETS below.
    "m28-carry-no-feature-check": (
        "  IF NOT COALESCE((public.check_feature_access(v_sub.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN\n    -- BACKLOG-3607",
        "  IF false THEN\n    -- BACKLOG-3607"),
    # the evidence compare now reads the base item (source item for a restored one)
    "m18-evidence-one-direction": (
        "                OR EXISTS (SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.new_item_id\n                           EXCEPT\n                           SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.base_item_id)\n",
        ""),
}

TARGETS = {"m28-carry-no-feature-check": "d02"}

NEW = [
    # --- version diff (plan §1, C-2, C-3, C-6) --------------------------------
    ("n01-diff-header-id-key", "d01", [
        ("             COALESCE(h.template_id::text, 'name:' || h.template_name) AS k\n        FROM public.submission_checklists h WHERE h.submission_id = v_parent.id",
         "             h.id::text AS k\n        FROM public.submission_checklists h WHERE h.submission_id = v_parent.id"),
        ("             COALESCE(h.template_id::text, 'name:' || h.template_name) AS k\n        FROM public.submission_checklists h WHERE h.submission_id = v_sub.id",
         "             h.id::text AS k\n        FROM public.submission_checklists h WHERE h.submission_id = v_sub.id")]),
    ("n02-zero-checklists-not-written", "d02", [
        ("  IF NOT v_has_headers THEN\n    IF jsonb_array_length(v_entries) > 0 THEN",
         "  IF NOT v_has_headers THEN\n    IF false THEN")]),
    ("n03-diff-not-idempotent", "d02", [
        ("    CONTINUE WHEN EXISTS (\n      SELECT 1 FROM jsonb_array_elements(v_sub.history) AS h(e)\n       WHERE h.e ->> 'type' = r.t",
         "    CONTINUE WHEN false AND EXISTS (\n      SELECT 1 FROM jsonb_array_elements(v_sub.history) AS h(e)\n       WHERE h.e ->> 'type' = r.t")]),
    ("n04-empty-feature-off-raises", "d02", [
        ("      RETURN jsonb_build_object('status', 'not_in_plan');",
         "      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';")]),
    ("n05-replaced-no-new-side-guard", "d03", [
        ("         AND EXISTS (SELECT 1 FROM nkeys b WHERE b.hid = n.id)\n", "")]),
    ("n06-replaced-rule-absent", "d03", [
        ("         AND p.added_at_review_by IS NULL\n         AND EXISTS (SELECT 1 FROM pkeys a",
         "         AND false AND p.added_at_review_by IS NULL\n         AND EXISTS (SELECT 1 FROM pkeys a")]),
    ("n07-zero-header-parent-plain-add", "d04", [
        ("CASE WHEN r.t = 'checklist_added' AND v_parent_headers = 0 THEN", "CASE WHEN false THEN")]),
    ("n08-removed-flag-for-added-lost", "d08", [
        ("CASE WHEN r.was_added AND r.t = 'checklist_removed' THEN", "CASE WHEN false THEN")]),
    ("n09-diff-counts-broker-removed-as-agent", "d07", [
        ("       WHERE p.removed_at_review_by IS NULL\n         AND NOT EXISTS (SELECT 1 FROM nh n WHERE n.k = p.k)",
         "       WHERE NOT EXISTS (SELECT 1 FROM nh n WHERE n.k = p.k)")]),
    ("n10-diff-no-after-broker-removal", "d08", [
        ("       WHERE NOT EXISTS (SELECT 1 FROM ph p WHERE p.k = n.k AND p.removed_at_review_by IS NULL)",
         "       WHERE NOT EXISTS (SELECT 1 FROM ph p WHERE p.k = n.k)")]),
    ("n40-removed-entry-no-header-id", "d01 d16", [
        ("      || CASE WHEN r.src_id IS NOT NULL THEN jsonb_build_object('removed_checklist_id', r.src_id) ELSE '{}'::jsonb END\n", "")]),
    ("n41-remove-counts-upload-rows", "d06", [
        ("count(DISTINCT (lm.kind, COALESCE(a.local_attachment_id, m.local_message_id)))", "count(DISTINCT lm.id)")]),
    # --- insert policies (C-1) -----------------------------------------------
    ("n11-hdr-policy-no-removed", "d05", [
        ("    AND submission_checklists.removed_at_review_by IS NULL\n    AND submission_checklists.removed_at_review_at IS NULL\n", "")]),
    ("n12-hdr-policy-no-restored-from", "d05", [
        ("    AND submission_checklists.restored_from_checklist_id IS NULL\n", "")]),
    ("n13-item-policy-no-restored-from", "d05", [
        ("    AND submission_checklist_items.restored_from_item_id IS NULL\n", "")]),
    # --- broker remove (plan §2) ----------------------------------------------
    ("n14-remove-hard-delete", "d06", [
        ("  UPDATE public.submission_checklists\n     SET removed_at_review_by = v_uid,\n         removed_at_review_at = v_now\n   WHERE id = v_hdr.id;",
         "  DELETE FROM public.submission_checklists WHERE id = v_hdr.id;")]),
    ("n15-remove-allows-needs-changes", "d06", [
        ("  IF v_rm.status IS NULL OR v_rm.status NOT IN ('submitted', 'resubmitted', 'under_review') THEN",
         "  IF v_rm.status IS NULL OR v_rm.status NOT IN ('submitted', 'resubmitted', 'under_review', 'needs_changes') THEN")]),
    ("n16-remove-no-superseded", "d06", [
        ("              WHERE c.parent_submission_id = v_rm.rm_sub_id) THEN", "              WHERE false) THEN")]),
    ("n17-tick-ignores-removed", "d06", [
        ("  IF v_row.removed_at_review_by IS NOT NULL THEN", "  IF false THEN")]),
    ("n18-add-no-unremove", "d06", [
        ("  IF FOUND AND v_removed_by IS NULL THEN", "  IF FOUND THEN")]),
    ("n19-remove-not-idempotent", "d06", [
        ("  IF v_hdr.removed_at_review_by IS NOT NULL THEN\n    RETURN jsonb_build_object('status', 'already_removed'",
         "  IF false THEN\n    RETURN jsonb_build_object('status', 'already_removed'")]),
    ("n20-carry-no-broker-removed-filter", "d07", [
        ("           AND ph.removed_at_review_by IS NULL\n      ),", "      ),")]),
    # --- restore (C-4) ----------------------------------------------------------
    ("n21-restore-restamp-caller-now", "d09", [
        ("         si.reviewer_checked, si.reviewer_checked_by, si.reviewer_checked_at, si.id",
         "         si.reviewer_checked, CASE WHEN si.reviewer_checked THEN v_uid END, CASE WHEN si.reviewer_checked THEN v_now END, si.id")]),
    ("n21b-restore-restamp-caller-only", "d09", [
        ("         si.reviewer_checked, si.reviewer_checked_by, si.reviewer_checked_at, si.id",
         "         si.reviewer_checked, CASE WHEN si.reviewer_checked THEN v_uid END, si.reviewer_checked_at, si.id")]),
    ("n22-restore-no-removal-record", "d09", [
        ("     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rs.history) AS h(e)",
         "     OR false AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rs.history) AS h(e)")]),
    ("n23-restore-any-ancestor", "d09", [
        ("   WHERE p.id = v_rs.parent_submission_id\n     AND p.organization_id = v_rs.organization_id",
         "   WHERE p.id = (SELECT h0.submission_id FROM public.submission_checklists h0 WHERE h0.id = p_source_checklist_id)\n     AND p.organization_id = v_rs.organization_id"),
        ("     AND v_rs.version IS NOT NULL AND p.version = v_rs.version - 1;", "     ;")]),
    ("n24-restore-copies-agent-tick", "d09", [
        ("         si.expected_document_type, false, si.sort_order,", "         si.expected_document_type, si.is_checked, si.sort_order,")]),
    ("n25-restore-reads-template", "d09", [
        ("  INSERT INTO public.submission_checklists\n    (submission_id, template_id, template_name, sort_order, added_at_review_by, added_at_review_at,\n     restored_from_checklist_id)",
         "  IF v_src.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.checklist_templates t WHERE t.id = v_src.template_id AND t.archived_at IS NULL) THEN\n    RETURN jsonb_build_object('status', 'template_not_found');\n  END IF;\n  INSERT INTO public.submission_checklists\n    (submission_id, template_id, template_name, sort_order, added_at_review_by, added_at_review_at,\n     restored_from_checklist_id)")]),
    ("n26-restore-not-idempotent", "d09", [
        ("  IF FOUND AND v_here.removed_at_review_by IS NULL THEN", "  IF false THEN")]),
    ("n27-restore-not-added-at-review", "d09 d10", [
        ("  VALUES (v_rs.rs_id, v_src.template_id, v_src.template_name, v_src.sort_order, v_uid, v_now, v_src.id)",
         "  VALUES (v_rs.rs_id, v_src.template_id, v_src.template_name, v_src.sort_order, NULL, NULL, v_src.id)")]),
    ("n28-restore-allows-broker-removed-source", "d16", [
        ("  IF v_src.removed_at_review_by IS NOT NULL\n     OR", "  IF false\n     OR")]),
    # --- the restored-item baseline (C-4.5) ---------------------------------------
    ("n29-baseline-note-restored-row", "d10", [
        ("               CASE WHEN si.id IS NOT NULL THEN si.note ELSE pi.note END AS parent_note,", "               pi.note AS parent_note,")]),
    ("n30-baseline-evidence-restored-row", "d10", [
        ("               COALESCE(si.id, pi.id) AS base_item_id,", "               pi.id AS base_item_id,")]),
    ("n31-evidence-not-widened", "d10", [
        ("                OR l.submission_checklist_item_id IN (", "                OR false AND l.submission_checklist_item_id IN (")]),
    ("n32-replaced-for-added-headers", "d11", [
        ("         AND p.added_at_review_by IS NULL\n         AND EXISTS (SELECT 1 FROM pkeys a", "         AND EXISTS (SELECT 1 FROM pkeys a")]),
    # --- lock (C-8), properties, rollback, apply twice -----------------------------
    ("n33-remove-no-key-lock", "d12", [
        ("   WHERE ts.id = v_hdr.submission_id\n     FOR UPDATE;", "   WHERE ts.id = v_hdr.submission_id\n     FOR NO KEY UPDATE;")]),
    ("n34-restore-no-key-lock", "d12", [
        ("   WHERE ts.id = p_submission_id\n     FOR UPDATE;\n\n  IF NOT FOUND OR NOT public.can_review_submission(v_rs.organization_id)",
         "   WHERE ts.id = p_submission_id\n     FOR NO KEY UPDATE;\n\n  IF NOT FOUND OR NOT public.can_review_submission(v_rs.organization_id)")]),
    ("n35-remove-invoker", "d13", [
        ("  p_checklist_id uuid\n)\nRETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER", "  p_checklist_id uuid\n)\nRETURNS jsonb\nLANGUAGE plpgsql\nSECURITY INVOKER")]),
    ("n36-restore-grant-public", "d13", [
        ("REVOKE EXECUTE ON FUNCTION public.restore_submission_checklist_at_review(uuid, uuid) FROM PUBLIC, anon;", "")]),
    ("n37-apply-not-idempotent", "d15", [
        ("  ADD COLUMN IF NOT EXISTS removed_at_review_by uuid NULL,", "  ADD COLUMN removed_at_review_by uuid NULL,")]),
]
NEW_RB = [
    ("n38-rollback-keeps-column", "d14", [("  DROP COLUMN IF EXISTS restored_from_checklist_id,\n", "")]),
    ("n39-rollback-keeps-remove-fn", "d14", [("DROP FUNCTION IF EXISTS public.remove_submission_checklist_at_review(uuid);\n", "")]),
]


def once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f"{label}: MUTATION NOT APPLIED (old text matched {n} times)")
    return text.replace(old, new, 1)


def main():
    draft = pathlib.Path(sys.argv[1]).read_text()
    draft_rb = pathlib.Path(sys.argv[2]).read_text()
    srcs96 = {"refusals": pathlib.Path(sys.argv[3]).read_text(), "added": pathlib.Path(sys.argv[4]).read_text()}
    out = pathlib.Path(sys.argv[5])
    written = []
    rewrite = []
    ported = kept = 0

    def emit(name, targets, kind, text):
        (out / f"{name}.sql").write_text(text)
        (out / f"{name}.targets").write_text(targets)
        (out / f"{name}.file").write_text(kind)
        written.append(name)

    for name, targets, kind, old, new in m3596.MUTANTS:
        if kind not in ("added", "refusals"):
            continue
        if name in REWRITES:
            old, new = REWRITES[name]
        targets = TARGETS.get(name, targets)
        move = m3596.MOVES.get(name)
        if draft.count(old) == 1 and (move is None or draft.replace(old, new, 1).count(move[0]) == 1):
            text = draft.replace(old, new, 1)
            if move:
                text = text.replace(move[0], move[1], 1)
            emit(name, targets, "draft", text)
            ported += 1
        elif draft.count(old) == 0 and srcs96[kind].count(old) == 1 and "CREATE TRIGGER" in new:
            text = srcs96[kind].replace(old, new, 1)
            if move:
                text = once(text, *move, name + " (move)")
            emit(name, targets, kind, text)
            kept += 1
        else:
            rewrite.append(f"{name} (draft matches {draft.count(old)})")
    if rewrite:
        sys.exit("NEEDS REWRITE: " + ", ".join(rewrite))
    for name, targets, edits in NEW:
        text = draft
        for old, new in edits:
            text = once(text, old, new, name)
        emit(name, targets, "draft", text)
    for name, targets, edits in NEW_RB:
        text = draft_rb
        for old, new in edits:
            text = once(text, old, new, name)
        emit(name, targets, "draft-rollback", text)
    print(f"mutants.py: {ported} ported to the draft, {kept} kept on their 3596 file, {len(NEW) + len(NEW_RB)} new")


if __name__ == "__main__":
    main()
