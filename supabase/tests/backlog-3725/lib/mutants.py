#!/usr/bin/env python3
"""BACKLOG-3725 mutants. Same contract as backlog-3403/lib/mutants.py: every
edit is an exact-string replace that must match exactly once, or the run
aborts; writes <out>/<id>.sql plus .targets, .file (draft|rollback), .desc.

The 3725 file re-creates finalize_submission, so the 3403 mutants that act on
the finalize body are re-run here against the 3725 copy (same ids, same
targets). The 3403 mutants on objects the 3725 file does not re-create stay
covered by the backlog-3403 harness."""
import importlib.util
import pathlib
import sys

draft_path, rb_path, out = map(pathlib.Path, sys.argv[1:4])
DRAFT = draft_path.read_text()
RB = rb_path.read_text()

FINALIZE_IDS = {"M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M12",
                "M18", "M24", "M27", "M31", "M38"}
# M15/M16 (finalize REVOKE terms) are equivalent here: CREATE OR REPLACE keeps
# the ACL the 3403 file set, so they run with want=green (EQ15/EQ16 below).


def ported():
    """The 3403 mutant table, read from its file without running its main."""
    src = (pathlib.Path(__file__).parents[2] / "backlog-3403/lib/mutants.py").read_text()
    table = src[src.index("M = ["):src.index("\nout.mkdir")]
    ns = {}
    exec(table, ns)  # noqa: S102 -- a literal list in a sibling test file
    return [m for m in ns["M"] if m[0] in FINALIZE_IDS]


GUARD_IF = ("    IF OLD.abandoned_at IS NOT NULL\n"
            "       OR OLD.submitted_by IS DISTINCT FROM auth.uid()\n"
            "       OR (OLD.status)::text <> 'uploading'\n       OR (NEW.status)::text <> 'uploading' THEN")

M = ported() + [
    ("EQ15", "EQUIVALENT: finalize REVOKE names PUBLIC only (re-create keeps the 3403 ACL)", "draft", ["X3", "X4"], [(
        "REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM PUBLIC, anon;",
        "REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM PUBLIC;")], "green"),
    ("A13", "storage DELETE policy without the abandoned_at term", "draft", ["P6n"], [(
        "\n         AND s.abandoned_at IS NOT NULL)));", ")));")]),
    ("A17", "MOST LIKELY WRONG: finalize ignores abandoned_at", "draft", ["R3"], [(
        "  IF v_sub.abandoned_at IS NOT NULL THEN\n    RETURN jsonb_build_object('ok', false, 'code', 'abandoned');\n  END IF;\n", "")]),
    ("A17b", "MOST LIKELY WRONG: finalize still reads the metadata flag", "draft", ["R3"], [(
        "  IF v_sub.abandoned_at IS NOT NULL THEN", "  IF coalesce(v_sub.submission_metadata->>'abandoned', '') = 'true' THEN")]),
    ("A37", "attachment-row DELETE policy without the abandoned_at term", "draft", ["RD1"], [(
        "       AND (transaction_submissions.status)::text = 'uploading'::text\n"
        "       AND transaction_submissions.abandoned_at IS NOT NULL));",
        "       AND (transaction_submissions.status)::text = 'uploading'::text));")]),
    ("A40", "guard lets a client insert abandoned_at", "draft", ["AB6"], [(
        "    IF NEW.abandoned_at IS NOT NULL THEN\n      RAISE EXCEPTION 'abandoned_at_insert'", "    IF false THEN\n      RAISE EXCEPTION 'abandoned_at_insert'")]),
    ("A41", "EQUIVALENT: guard without the only-from-NULL term (extra protection: the USING term keeps clients off a fenced row)", "draft", ["AB2", "AB3"], [(
        GUARD_IF, GUARD_IF.replace("    IF OLD.abandoned_at IS NOT NULL\n       OR OLD", "    IF OLD"))], "green"),
    ("U1", "submitter USING branch without abandoned_at IS NULL (a 2.38 flip reaches a fenced row)", "draft", ["AB5"], [(
        "AND ((status)::text = 'uploading'::text) AND (abandoned_at IS NULL))", "AND ((status)::text = 'uploading'::text))")]),
    ("A48", "guard refuses the service role / definer callers too", "draft", ["SV1"], [(
        "  IF current_user NOT IN ('authenticated', 'anon') THEN\n    RETURN NEW;\n  END IF;\n", "")]),
    ("A42", "EQUIVALENT: guard without the submitter term (RLS USING already limits uploading rows to the submitter)", "draft", ["AB4"], [(
        GUARD_IF, GUARD_IF.replace("\n       OR OLD.submitted_by IS DISTINCT FROM auth.uid()", ""))], "green"),
    ("A47", "EQUIVALENT: guard without the OLD status term (the NEW status term catches every reachable case)", "draft", ["AB4", "AB7"], [(
        GUARD_IF, GUARD_IF.replace("\n       OR (OLD.status)::text <> 'uploading'", ""))], "green"),
    ("A43", "guard without the NEW status term", "draft", ["AB7"], [(
        GUARD_IF, GUARD_IF.replace("\n       OR (NEW.status)::text <> 'uploading' THEN", " THEN"))]),
    ("A45", "trigger on UPDATE only", "draft", ["AB6"], [(
        "  BEFORE INSERT OR UPDATE ON public.transaction_submissions\n  FOR EACH ROW EXECUTE FUNCTION public.guard_submission_abandoned_at();",
        "  BEFORE UPDATE ON public.transaction_submissions\n  FOR EACH ROW EXECUTE FUNCTION public.guard_submission_abandoned_at();")]),
    ("A46", "column added without IF NOT EXISTS (not re-runnable)", "draft", ["G2"], [(
        "ADD COLUMN IF NOT EXISTS abandoned_at", "ADD COLUMN abandoned_at")]),
    ("RB1", "rollback leaves the column", "rollback", ["G1"], [(
        "ALTER TABLE public.transaction_submissions DROP COLUMN IF EXISTS abandoned_at;\n", "")]),
    ("RB2", "rollback leaves finalize on abandoned_at", "rollback", ["G1"], [(
        "  IF coalesce(v_sub.submission_metadata->>'abandoned', '') = 'true' THEN",
        "  IF coalesce(v_sub.submission_metadata->>'abandoned', '') = 'true' OR false THEN")]),
    ("RB4", "rollback leaves the submitter USING term", "rollback", ["G1"], [(
        "    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text))\n    OR",
        "    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text) AND (abandoned_at IS NULL))\n    OR")]),
    ("RB3", "rollback leaves the guard trigger", "rollback", ["G1"], [(
        "DROP TRIGGER IF EXISTS submission_abandoned_at_guard ON public.transaction_submissions;\n"
        "DROP FUNCTION IF EXISTS public.guard_submission_abandoned_at();\n", "")]),
]

out.mkdir(parents=True, exist_ok=True)
for entry in M:
    mid, desc, kind, targets, edits = entry[:5]
    want = entry[5] if len(entry) > 5 else "red"
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
    (out / f"{mid}.want").write_text(want)
print(f"{len(M)} mutants written")
