#!/usr/bin/env python3
"""BACKLOG-3608 mutants: exact-string replacements on the 3608 file.

usage: mutants.py <3608 file> <out dir>
Writes <out>/<name>.sql and <out>/<name>.targets. A replacement that does not
match exactly once aborts (MUTATION NOT APPLIED).
"""
import sys

# the history refusal (section 1a)
HIST_IF = """  -- A client statement may not change the history at all.
  IF current_user IN ('authenticated', 'anon') THEN"""
CHECK = HIST_IF + """
    RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
  END IF;
"""
UNCHANGED = """  IF NEW.status_history IS NOT DISTINCT FROM OLD.status_history THEN
    RETURN NEW;
  END IF;
"""
AGENT_TYPES = "('checklist_removed', 'checklist_added', 'checklist_review_cleared', 'checklist_review_unavailable')"

# the client-statement block (sections 1b and 1c)
CLIENT_IF = """  IF current_user IN ('authenticated', 'anon') THEN
    -- Review fields"""
REVIEW_WATCH = """    IF NEW.reviewed_by     IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at  IS DISTINCT FROM OLD.reviewed_at
       OR NEW.review_notes IS DISTINCT FROM OLD.review_notes THEN"""
REVIEWER = """      IF NOT public.can_review_submission(OLD.organization_id) THEN
        RAISE EXCEPTION 'review_fields_reviewer_only' USING ERRCODE = '42501';
      END IF;
"""
SELF_ID = """      IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
         AND NEW.reviewed_by IS DISTINCT FROM auth.uid() THEN"""
OWNER_IF = "    IF NEW.id                      IS DISTINCT FROM OLD.id\n"
OWNER_REST = """       OR NEW.organization_id      IS DISTINCT FROM OLD.organization_id
       OR NEW.submitted_by         IS DISTINCT FROM OLD.submitted_by
       OR NEW.local_transaction_id IS DISTINCT FROM OLD.local_transaction_id
       OR NEW.parent_submission_id IS DISTINCT FROM OLD.parent_submission_id
       OR NEW.version              IS DISTINCT FROM OLD.version THEN"""
OWNER_LAST = "       OR NEW.version              IS DISTINCT FROM OLD.version THEN"
OWNER_BLOCK = """    -- Ownership columns are fixed for a client statement.
""" + OWNER_IF + OWNER_REST + """
      RAISE EXCEPTION 'submission_owner_fields_locked' USING ERRCODE = '42501';
    END IF;
"""

# the UPDATE rule (section 2)
USING_SUBMITTER = "((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text))"
USING_3596 = "((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])))"
CHECK_SUBMITTER = "ARRAY['resubmitted'::text, 'uploading'::text, 'submitted'::text]"
CHECK_3596 = "ARRAY['needs_changes'::text, 'resubmitted'::text, 'uploading'::text, 'submitted'::text]"


def client_block(src):
    return src[src.index(CLIENT_IF):src.index(UNCHANGED)]


MUTANTS = [
    # ---- history refusal (1a) ----
    # the new refusal absent entirely
    ("k01", "e01 e02", [(CHECK, "")]),
    # session_user: in production the session user is the PostgREST login
    # role, in the harness postgres -- never a client role, so nothing refused
    ("k02", "e01 e02", [(HIST_IF, HIST_IF.replace("IF current_user", "IF session_user"))]),
    # the JWT role instead of the executing role: inside a DEFINER function the
    # JWT still says authenticated, so every review function is refused
    ("k03", "e04 e05", [(HIST_IF, HIST_IF.replace("IF current_user", "IF auth.role()"))]),
    # the refusal before the unchanged-history return: every client UPDATE of
    # the row is refused, status moves included
    ("k04", "e03", [(UNCHANGED + "\n" + CHECK, CHECK + UNCHANGED)]),
    # an allow-list of the types an agent's version carries, checked on the
    # APPENDED entries only
    ("k05", "e01", [(HIST_IF, HIST_IF.replace(") THEN",
                      ") AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_new) WITH ORDINALITY AS x(e, o)"
                      " WHERE x.o > jsonb_array_length(COALESCE(OLD.status_history, '[]'::jsonb))"
                      " AND x.e ->> 'type' NOT IN " + AGENT_TYPES + ") THEN"))]),
    # the same allow-list checked on the WHOLE array
    ("k06", "e01", [(HIST_IF, HIST_IF.replace(") THEN",
                      ") AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_new) AS x(e)"
                      " WHERE x.e ->> 'type' NOT IN " + AGENT_TYPES + ") THEN"))]),
    # only the last entry inspected, and only for a broker type
    ("k07", "e01", [(HIST_IF, HIST_IF.replace(") THEN", ") AND (v_new -> -1 ->> 'type') = 'checklist_review' THEN"))]),
    # the guard trigger renamed so it sorts AFTER track_status_changes
    ("k08", "e03 e05", [("END\n$$;\n",
                          "END\n$$;\nALTER TRIGGER status_history_append_only ON public.transaction_submissions"
                          " RENAME TO zz_status_history_append_only;\n")]),
    # the refusal limited to the submitter (reviewer path left open)
    ("k09", "e02", [(HIST_IF, HIST_IF.replace(") THEN", ") AND NEW.submitted_by = auth.uid() THEN"))]),
    # SR mSR2: the role GUC instead of current_user (SECURITY DEFINER does not
    # change it, so DEFINER writers are refused)
    ("k10", "e04", [(HIST_IF, HIST_IF.replace("IF current_user", "IF current_setting('role')"))]),
    # SR mSR5: anon only
    ("k11", "e01 e02", [(HIST_IF, HIST_IF.replace("IN ('authenticated', 'anon')", "IN ('anon')"))]),

    # ---- review fields (1b) ----
    # SR mS1a: the client block after the unchanged-history return (a
    # review-field or ownership change without a history change passes)
    ("k20", "e06 e09", [("__MOVE_CLIENT_BLOCK__", None)]),
    # SR mS1b: the self-id check removed
    ("k21", "e06", [(SELF_ID, "      IF false THEN")]),
    # the reviewer check removed (only the self-id check left)
    ("k22", "e06", [(REVIEWER, "")]),
    # SR mS1e: only reviewed_by watched
    ("k23", "e06", [(REVIEW_WATCH, "    IF NEW.reviewed_by     IS DISTINCT FROM OLD.reviewed_by THEN")]),
    # SR mS1g: the reviewer check on the NEW organization
    ("k24", "e07", [("public.can_review_submission(OLD.organization_id)", "public.can_review_submission(NEW.organization_id)")]),
    # SR sB: the self-id check is NULL-blind (a reviewer clearing reviewed_by
    # to NULL on a row a colleague set is not refused)
    ("sB", "e06", [("AND NEW.reviewed_by IS DISTINCT FROM auth.uid() THEN",
                     "AND NEW.reviewed_by <> auth.uid() THEN")]),

    # ---- ownership columns (1c) ----
    # the block absent
    ("k30", "e09", [(OWNER_BLOCK, "")]),
    # organization_id only
    ("k31", "e09", [(OWNER_IF + OWNER_REST, "    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN")]),
    # limited to the submitter (a broker of two orgs moves a row)
    ("k32", "e09", [(OWNER_IF, "    IF NEW.submitted_by = auth.uid() AND (NEW.id IS DISTINCT FROM OLD.id\n"),
                    (OWNER_LAST, OWNER_LAST.replace(" THEN", ") THEN"))]),

    # ---- UPDATE rule (2) ----
    # the 3596 submitter USING kept (needs_changes still reachable)
    ("k40", "e08 e06 c20", [(USING_SUBMITTER, USING_3596)]),
    # both submitter lists back to 3596
    ("k41", "e08 e13", [(USING_SUBMITTER, USING_3596), (CHECK_SUBMITTER, CHECK_3596)]),
    # SR sD: the submitter USING loosened to also match its own 'submitted'
    # rows (the agent "re-finalizes" a row already awaiting review)
    ("sD", "e08", [(USING_SUBMITTER,
                     "((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['uploading'::text, 'submitted'::text])))")]),
    # needs_changes back in the submitter WITH CHECK
    ("k43", "e13", [(CHECK_SUBMITTER, CHECK_3596)]),
    # needs_changes removed from the whole WITH CHECK by narrowing the
    # reviewer branch too (reviewers limited to their own submissions)
    ("k44", "e13 e03", [("    OR (organization_id IN ( SELECT organization_members.organization_id\n       FROM organization_members\n"
                         "      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid))",
                         "    OR (submitted_by = ( SELECT auth.uid() AS uid) AND organization_id IN ( SELECT organization_members.organization_id\n       FROM organization_members\n"
                         "      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid))")]),
    # the submitter branch narrowed too far: 'uploading' dropped from USING
    ("k42", "e03 e12", [(USING_SUBMITTER, "((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = 'needs_changes'::text))")]),
]


def main():
    src_path, out = sys.argv[1], sys.argv[2]
    src = open(src_path).read()
    for name, targets, reps in MUTANTS:
        text = src
        for old, new in reps:
            if old == "__MOVE_CLIENT_BLOCK__":
                blk = client_block(text)
                old, new = blk + UNCHANGED, UNCHANGED + "\n" + blk
            c = text.count(old)
            if c != 1:
                sys.exit(f"{name}: MUTATION NOT APPLIED ({c} matches for {old[:60]!r})")
            text = text.replace(old, new)
        if text == src:
            sys.exit(f"{name}: MUTATION NOT APPLIED (identical)")
        open(f"{out}/{name}.sql", "w").write(text)
        open(f"{out}/{name}.targets", "w").write(targets)


if __name__ == "__main__":
    main()
