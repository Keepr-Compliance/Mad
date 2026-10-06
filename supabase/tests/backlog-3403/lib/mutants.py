#!/usr/bin/env python3
"""BACKLOG-3403 mutants. Every edit is an exact-string replace that must match
exactly once, or the run aborts. Writes <out>/<id>.sql plus .targets, .file
(draft|rollback) and .desc. run.sh refuses a mutant whose diff is empty and
prints MUTATION APPLIED with the first changed line.

M1-M12 keep the plan pre-run's numbering (pm_comments 013cbc9b) so the SR's
re-run maps one to one; M13 onward are new in the build."""
import pathlib
import sys

draft_path, rb_path, out = map(pathlib.Path, sys.argv[1:4])
DRAFT = draft_path.read_text()
RB = rb_path.read_text()

M = [
    ("M01", "drop the storage-object check", "draft", ["C1b", "G3"], [(
        "count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM storage.objects o\n"
        "                                WHERE o.bucket_id = 'submission-attachments' AND o.name = d.path)),", "0,")]),
    ("M02", "MOST LIKELY WRONG: compare message COUNT, not the id set", "draft", ["C11"], [(
        "  SELECT count(*) INTO v_msg_missing FROM unnest(v_msgs) d\n"
        "   WHERE NOT EXISTS (SELECT 1 FROM public.submission_messages m WHERE m.id = d AND m.submission_id = p_submission_id);\n"
        "  SELECT count(*) INTO v_msg_extra FROM public.submission_messages m\n"
        "   WHERE m.submission_id = p_submission_id AND NOT (m.id = ANY(v_msgs));",
        "  SELECT greatest(cardinality(v_msgs) - count(*), 0) INTO v_msg_missing FROM public.submission_messages m WHERE m.submission_id = p_submission_id;\n"
        "  v_msg_extra := 0;")]),
    ("M03", "drop the folder-scope check in finalize", "draft", ["C12"], [(
        "count(*) FILTER (WHERE d.path IS NULL OR left(d.path, length(v_prefix)) <> v_prefix),", "0,")]),
    ("M04", "drop the checklist check", "draft", ["C3"], [(
        "     OR (v_cl_expected IS NOT NULL AND v_cl_found <> v_cl_expected) THEN", " THEN")]),
    ("M05", "drop the owner check in finalize", "draft", ["C4"], [(
        "  IF v_sub.submitted_by <> v_uid THEN RETURN jsonb_build_object('ok', false, 'code', 'not_owner'); END IF;\n", "")]),
    ("M06", "drop the idempotent branch", "draft", ["C6"], [(
        "  IF v_sub.status = v_target THEN RETURN jsonb_build_object('ok', true, 'already_final', true, 'status', v_target); END IF;\n", "")]),
    ("M07", "drop the attachment-to-message link check", "draft", ["C13"], [(
        "count(*) FILTER (WHERE a.id IS NOT NULL AND (a.message_id IS DISTINCT FROM d.message_id\n"
        "                                OR (d.message_id IS NOT NULL AND NOT (d.message_id = ANY(v_msgs))))),", "0,")]),
    ("M08", "drop the undeclared-attachment check", "draft", ["C14"], [(
        "     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_att) e WHERE (e->>'id')::uuid = a.id);", "     AND false;")]),
    ("M09", "message insert rule without the uploading term", "draft", ["P3"], [(
        "     WHERE transaction_submissions.submitted_by = (SELECT auth.uid() AS uid)\n"
        "       AND (transaction_submissions.status)::text = 'uploading'::text));",
        "     WHERE transaction_submissions.submitted_by = (SELECT auth.uid() AS uid)));")]),
    ("M10", "storage DELETE policy without the status term", "draft", ["P7"], [(
        "         AND (s.status)::text = 'uploading'::text\n         AND coalesce(s.submission_metadata->>'abandoned', '') = 'true')));",
        "         AND coalesce(s.submission_metadata->>'abandoned', '') = 'true')));")]),
    ("M11", "storage DELETE policy without the submitter term", "draft", ["P11"], [(
        "         AND s.submitted_by = (SELECT auth.uid() AS uid)\n         AND (s.status)::text = 'uploading'::text\n         AND coalesce(",
        "         AND (s.status)::text = 'uploading'::text\n         AND coalesce(")]),
    ("M12", "target status always submitted", "draft", ["C7"], [(
        "v_target := CASE WHEN v_sub.parent_submission_id IS NOT NULL THEN 'resubmitted' ELSE 'submitted' END;",
        "v_target := 'submitted';")]),
    ("M13", "storage DELETE policy without the abandoned term (the SR-reviewed draft text)", "draft", ["P6n"], [(
        "\n         AND coalesce(s.submission_metadata->>'abandoned', '') = 'true')));", ")));")]),
    ("M14", "reviewer WITH CHECK still accepts 'uploading'", "draft", ["X2"], [(
        "    OR (((status)::text <> 'uploading'::text)\n        AND (organization_id IN",
        "    OR ((true)\n        AND (organization_id IN")]),
    ("M15", "finalize REVOKE names PUBLIC only", "draft", ["X3", "X4"], [(
        "REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM PUBLIC, anon;",
        "REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM PUBLIC;")]),
    ("M16", "finalize REVOKE names anon only", "draft", ["X3", "X4"], [(
        "REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM PUBLIC, anon;",
        "REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM anon;")]),
    ("M17", "MOST LIKELY WRONG: finalize ignores the abandon fence", "draft", ["R3"], [(
        "  IF coalesce(v_sub.submission_metadata->>'abandoned', '') = 'true' THEN\n"
        "    RETURN jsonb_build_object('ok', false, 'code', 'abandoned');\n  END IF;\n", "")]),
    ("M18", "finalize replaces submission_metadata instead of merging", "draft", ["E1"], [(
        "submission_metadata = coalesce(submission_metadata, '{}'::jsonb)\n"
        "                               || jsonb_build_object('finalized_by', 'finalize_submission')",
        "submission_metadata = jsonb_build_object('finalized_by', 'finalize_submission')")]),
    ("M19", "MOST LIKELY WRONG for the report: reason_code accepts free text", "draft", ["T8"], [(
        "  CONSTRAINT submission_attempts_reason_check CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),\n", "")]),
    ("M20", "attempts SELECT without the own-row term", "draft", ["T2"], [(
        "    (user_id = (SELECT auth.uid()))\n    OR public.can_review_submission", "    false\n    OR public.can_review_submission")]),
    ("M21", "attempts SELECT without the reviewer term", "draft", ["T2"], [(
        "    OR public.can_review_submission(organization_id)\n", "")]),
    ("M22", "attempts SELECT without the internal-user term", "draft", ["T2"], [(
        "\n    OR EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid()))", "")]),
    ("M23", "a committed attempt can be overwritten", "draft", ["T7"], [
        ("    IF v_existing.outcome = 'committed' THEN\n"
         "      RETURN jsonb_build_object('ok', true, 'outcome', 'committed', 'unchanged', true);\n    END IF;\n", ""),
        ("   WHERE a.user_id = v_uid AND a.outcome <> 'committed'", "   WHERE a.user_id = v_uid")]),
    ("M24", "finalize does not mark an existing attempt committed", "draft", ["T6"], [(
        "     SET outcome = 'committed', stage = 'finalize', reason_code = NULL, updated_at = now(), ended_at = now()\n   WHERE a.user_id = v_uid;",
        "     SET updated_at = now()\n   WHERE false;")]),
    ("M25", "counts stored as sent (no sanitising)", "draft", ["T1"], [(
        "  INSERT INTO public.submission_attempts AS a\n    (submission_id, user_id, organization_id, is_resubmit, outcome, stage, reason_code,",
        "  v_counts := p_counts;\n  INSERT INTO public.submission_attempts AS a\n    (submission_id, user_id, organization_id, is_resubmit, outcome, stage, reason_code,")]),
    ("M26", "record_submission_attempt without the membership check", "draft", ["T4"], [(
        "  IF NOT EXISTS (SELECT 1 FROM public.organization_members om\n"
        "                  WHERE om.organization_id = p_organization_id AND om.user_id = v_uid) THEN\n"
        "    RETURN jsonb_build_object('ok', false, 'code', 'not_member');\n  END IF;\n", "")]),
    ("M27", "attachment_count from the manifest length, not distinct ids", "draft", ["C5b"], [(
        "attachment_count = v_att_ids,", "attachment_count = jsonb_array_length(v_att),")]),
    ("M28", "record_submission_attempt without the submission-owner check", "draft", ["T5"], [(
        "  IF EXISTS (SELECT 1 FROM public.transaction_submissions s\n"
        "              WHERE s.id = p_submission_id\n"
        "                AND (s.submitted_by <> v_uid OR s.organization_id <> p_organization_id)) THEN\n"
        "    RETURN jsonb_build_object('ok', false, 'code', 'not_owner');\n  END IF;\n", "")]),
    ("M29", "record_submission_attempt REVOKE names PUBLIC only", "draft", ["X3"], [(
        "REVOKE EXECUTE ON FUNCTION public.record_submission_attempt(uuid, uuid, text, text, text, integer, jsonb, boolean, text, text) FROM PUBLIC, anon;",
        "REVOKE EXECUTE ON FUNCTION public.record_submission_attempt(uuid, uuid, text, text, text, integer, jsonb, boolean, text, text) FROM PUBLIC;")]),
    ("M30", "no REVOKE on the new table (default client grants stay)", "draft", ["T3", "X3"], [(
        "REVOKE ALL ON public.submission_attempts FROM PUBLIC, anon, authenticated;\n", "")]),
    ("M31", "finalize as SECURITY INVOKER", "draft", ["C5"], [(
        "RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''\nAS $fn$\nDECLARE\n  v_uid uuid := auth.uid();\n  v_sub",
        "RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = ''\nAS $fn$\nDECLARE\n  v_uid uuid := auth.uid();\n  v_sub")]),
    ("M32", "attachment insert rule without the folder segment-2 term", "draft", ["H1", "X1"], [(
        "\n       AND split_part(submission_attachments.storage_path, '/'::text, 2) = (ts.id)::text));", "));")]),
    ("M33", "attachment insert rule without the folder segment-1 term", "draft", ["H1b"], [(
        "       AND split_part(submission_attachments.storage_path, '/'::text, 1) = (ts.organization_id)::text\n", "")]),
    ("M34", "attachment insert rule without the uploading term", "draft", ["P4"], [(
        "       AND (ts.status)::text = 'uploading'::text\n       AND split_part(submission_attachments.storage_path", "       AND split_part(submission_attachments.storage_path")]),
    ("M35", "table created without IF NOT EXISTS (not re-runnable)", "draft", ["G2"], [(
        "CREATE TABLE IF NOT EXISTS public.submission_attempts (", "CREATE TABLE public.submission_attempts (")]),
    ("M36", "record_submission_attempt accepts outcome committed from a client", "draft", ["SR1"], [(
        "  IF p_outcome = 'committed' THEN\n    RETURN jsonb_build_object('ok', false, 'code', 'committed_is_server_only');\n  END IF;\n", "")]),
    ("M37", "attachment-row DELETE policy without the abandoned term", "draft", ["RD1"], [(
        "       AND (transaction_submissions.status)::text = 'uploading'::text\n"
        "       AND coalesce(transaction_submissions.submission_metadata->>'abandoned', '') = 'true'));",
        "       AND (transaction_submissions.status)::text = 'uploading'::text));")]),
    ("M38", "finalize reads the submission without FOR UPDATE", "draft", ["L1"], [(
        "SELECT * INTO v_sub FROM public.transaction_submissions WHERE id = p_submission_id FOR UPDATE;",
        "SELECT * INTO v_sub FROM public.transaction_submissions WHERE id = p_submission_id;")]),
    ("RB1", "rollback leaves the new message index", "rollback", ["G1"], [(
        "DROP INDEX IF EXISTS public.submission_messages_submission_id_idx;\n", "")]),
    ("RB3", "rollback leaves the attachment-row DELETE term", "rollback", ["G1"], [(
        "       AND ((transaction_submissions.status)::text = 'uploading'::text))));\n\nDROP POLICY IF EXISTS agents_can_insert_attachments",
        "       AND ((transaction_submissions.status)::text = 'uploading'::text) AND coalesce(transaction_submissions.submission_metadata->>'abandoned', '') = 'true')));\n\nDROP POLICY IF EXISTS agents_can_insert_attachments")]),
    ("RB2", "rollback leaves the reviewer WITH CHECK tightened", "rollback", ["G1"], [(
        "    OR (organization_id IN (SELECT organization_members.organization_id\n                              FROM public.organization_members",
        "    OR ((status)::text <> 'uploading'::text AND organization_id IN (SELECT organization_members.organization_id\n                              FROM public.organization_members")]),
]

out.mkdir(parents=True, exist_ok=True)
for mid, desc, kind, targets, edits in M:
    text = DRAFT if kind == "draft" else RB
    for find, repl in edits:
        n = text.count(find)
        if n != 1:
            sys.exit(f"{mid}: edit matched {n} times (must be exactly 1): {find[:80]!r}")
        text = text.replace(find, repl)
    (out / f"{mid}.sql").write_text(text)
    (out / f"{mid}.targets").write_text(" ".join(targets))
    (out / f"{mid}.file").write_text(kind)
    (out / f"{mid}.desc").write_text(desc)
print(f"{len(M)} mutants written")
