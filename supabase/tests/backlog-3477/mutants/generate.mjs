#!/usr/bin/env node
// BACKLOG-3477: derive every mutant from the SHIPPED migration.
//
//   node supabase/tests/backlog-3477/mutants/generate.mjs          write every mutant
//   node supabase/tests/backlog-3477/mutants/generate.mjs --check  exit 1 if a file on disk differs
//
// Each mutant is the whole migration with ONE targeted change, made by an
// exact string replacement that THROWS when its pattern is absent or occurs
// more than once, so a mutant can never be written unchanged. run.sh loads the
// mutant in place of the migration and refuses to count a result unless the
// mutant differs from the shipped file (it prints MUTATION APPLIED with the
// first changed line).
//
// Header line run.sh reads:  -- targets: c05 c08   controls that must go RED
//
// Re-run after ANY change to the migration, then run.sh mutants.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const MIG_PATH = "supabase/migrations/20260925073000_backlog_3477_submission_checklist_review.sql";
const MIG = readFileSync(join(REPO, MIG_PATH), "utf8");

/** Exact replacement; throws unless `from` occurs exactly once in `text`. */
function edit(text, from, to, label) {
  const first = text.indexOf(from);
  if (first === -1) throw new Error(`${label}: pattern not found:\n${from}`);
  if (text.indexOf(from, first + from.length) !== -1) throw new Error(`${label}: pattern occurs more than once:\n${from}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

/** Exact replacement inside one CREATE POLICY / CREATE FUNCTION block only. */
function editIn(text, blockStart, blockEnd, from, to, label) {
  const s = text.indexOf(blockStart);
  if (s === -1 || text.indexOf(blockStart, s + 1) !== -1) throw new Error(`${label}: block start not unique: ${blockStart}`);
  const e = text.indexOf(blockEnd, s);
  if (e === -1) throw new Error(`${label}: block end not found after ${blockStart}`);
  const block = text.slice(s, e + blockEnd.length);
  return text.slice(0, s) + edit(block, from, to, label) + text.slice(e + blockEnd.length);
}

const OLD_ROLES = `OR EXISTS (
              SELECT 1
                FROM public.organization_members om
               WHERE om.organization_id = ts.organization_id
                 AND om.user_id = (SELECT auth.uid())
                 AND om.role IN ('broker', 'admin')
            ))`;
const HELPER_CALL = "OR public.can_review_submission(ts.organization_id))";
const policyRevert = (name) => (t) =>
  editIn(t, `CREATE POLICY ${name} ON`, ");\n", HELPER_CALL, OLD_ROLES, name);

const TICK = ["CREATE OR REPLACE FUNCTION public.set_submission_checklist_reviewer_check(", "$$;\n"];
const ADD = ["CREATE OR REPLACE FUNCTION public.add_submission_checklist_at_review(", "$$;\n"];
const SNAP = ["CREATE OR REPLACE FUNCTION public.snapshot_submission_checklists(", "$$;\n"];
const GUARD = ["CREATE OR REPLACE FUNCTION public.guard_status_history_append_only(", "$$;\n"];

const MUTANTS = [
  // --- the helper ---------------------------------------------------------
  ["m01-helper-without-it-admin", "c05 c08 c11",
    (t) => edit(t, "AND om.role IN ('broker', 'admin', 'it_admin')", "AND om.role IN ('broker', 'admin')", "m01")],
  ["m02-helper-any-member", "c06 c11",
    (t) => edit(t, "\n       AND om.role IN ('broker', 'admin', 'it_admin')", "", "m02")],
  ["m03-helper-anon-revoked", "c11 c15",
    (t) => edit(t, "TO anon, authenticated;", "TO authenticated;\nREVOKE EXECUTE ON FUNCTION public.can_review_submission(uuid) FROM anon;", "m03")],
  // --- each read rule back on the old role list ---------------------------
  ["m04a-submissions-read-old-roles", "c11 c12", (t) => edit(t,
    "USING (submitted_by = (SELECT auth.uid())\n         OR public.can_review_submission(organization_id));",
    "USING (submitted_by = (SELECT auth.uid())\n         OR organization_id IN (SELECT organization_members.organization_id FROM public.organization_members\n          WHERE organization_members.user_id = (SELECT auth.uid()) AND organization_members.role IN ('broker', 'admin')));",
    "m04a")],
  ["m04b-messages-read-old-roles", "c11 c12", policyRevert("message_access_via_submission")],
  ["m04c-attachments-read-old-roles", "c11 c12", policyRevert("attachment_access_via_submission")],
  ["m04d-checklists-read-old-roles", "c11 c12", policyRevert("submission_checklists_select")],
  ["m04e-items-read-old-roles", "c11 c12", policyRevert("submission_checklist_items_select")],
  ["m04f-links-read-old-roles", "c11 c12", policyRevert("submission_checklist_links_select")],
  ["m04g-members-read-old-roles", "c11 c12", policyRevert("submission_checklist_link_members_select")],
  // --- insert rules --------------------------------------------------------
  ["m05-header-insert-allows-added-at-review", "c08",
    (t) => edit(t, "    submission_checklists.added_at_review_by IS NULL\n    AND submission_checklists.added_at_review_at IS NULL\n    AND EXISTS (",
                   "    EXISTS (", "m05")],
  ["m06-item-insert-allows-reviewer-values", "c10",
    (t) => edit(t, "    submission_checklist_items.reviewer_checked = false\n    AND submission_checklist_items.reviewer_checked_by IS NULL\n    AND submission_checklist_items.reviewer_checked_at IS NULL\n    AND EXISTS (",
                   "    EXISTS (", "m06")],
  ["m07-header-insert-without-feature", "c03",
    (t) => edit(t, "\n         AND COALESCE((public.check_feature_access(ts.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false)\n    )\n  );",
                   "\n    )\n  );", "m07")],
  ["m08-header-insert-without-status", "c04",
    (t) => editIn(t, "CREATE POLICY submission_checklists_insert ON", ");\n", "\n         AND ts.status = 'uploading'", "", "m08")],
  // --- snapshot --------------------------------------------------------------
  ["m09-snapshot-first-attachment-only", "c01",
    (t) => edit(t, "SELECT COALESCE(array_agg(a.id), '{}')", "SELECT COALESCE((array_agg(a.id))[1:1], '{}')", "m09")],
  ["m10-snapshot-writes-empty-links", "c01",
    (t) => edit(t, "        IF COALESCE(cardinality(v_targets), 0) = 0 THEN\n          n_dropped_links := n_dropped_links + 1;\n          CONTINUE;\n        END IF;\n", "", "m10")],
  ["m11-snapshot-unknown-kind-skipped", "c02",
    (t) => edit(t, "           OR v_kind IS NULL OR v_kind NOT IN ('attachment', 'email')\n", "", "m11")],
  ["m12-snapshot-security-definer", "c03 c04 c15",
    (t) => editIn(t, SNAP[0], SNAP[1], "SECURITY INVOKER", "SECURITY DEFINER", "m12")],
  ["m13-snapshot-passes-reviewer-values", "c10",
    (t) => edit(edit(t,
      "         expected_document_type, is_checked, note, sort_order)\n      VALUES (p_submission_id, v_header_id,",
      "         expected_document_type, is_checked, note, sort_order, reviewer_checked, reviewer_checked_by, reviewer_checked_at)\n      VALUES (p_submission_id, v_header_id,",
      "m13a"),
      "              COALESCE((it ->> 'sort_order')::integer, 0))\n      RETURNING id INTO v_item_id;",
      "              COALESCE((it ->> 'sort_order')::integer, 0),\n              COALESCE((it ->> 'reviewer_checked')::boolean, false), (it ->> 'reviewer_checked_by')::uuid, (it ->> 'reviewer_checked_at')::timestamptz)\n      RETURNING id INTO v_item_id;",
      "m13b")],
  // --- tick ------------------------------------------------------------------
  ["m14-tick-writes-is-checked", "c05",
    (t) => edit(t, "     SET reviewer_checked    = p_checked,\n", "     SET reviewer_checked    = p_checked,\n         is_checked          = p_checked,\n", "m14")],
  ["m15-tick-appends-on-no-op", "c05",
    (t) => edit(t, "  IF v_row.reviewer_checked = p_checked THEN\n    RETURN jsonb_build_object('changed', false, 'reviewer_checked', p_checked);\n  END IF;\n", "", "m15")],
  ["m16-tick-without-status-gate", "c06",
    (t) => editIn(t, TICK[0], TICK[1], "     OR v_row.status NOT IN ('submitted', 'resubmitted', 'under_review', 'needs_changes') THEN", " THEN", "m16")],
  ["m17-tick-without-feature-check", "c06",
    (t) => editIn(t, TICK[0], TICK[1],
      "  IF NOT COALESCE((public.check_feature_access(v_row.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN\n    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';\n  END IF;\n", "", "m17")],
  ["m18-tick-allows-added-at-review", "c05",
    (t) => edit(t, "  IF v_row.added_at_review_by IS NOT NULL THEN\n    RAISE EXCEPTION 'added_at_review' USING ERRCODE = '42501';\n  END IF;\n", "", "m18")],
  ["m19-tick-entry-with-status-key", "c05 c09",
    (t) => edit(t, "           'type', 'checklist_review',\n", "           'type', 'checklist_review',\n           'status', v_row.status,\n", "m19")],
  ["m20-tick-reads-history-into-variable", "c07",
    (t) => editIn(t, TICK[0], TICK[1],
      "  UPDATE public.transaction_submissions\n     SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(",
      "  SELECT status_history INTO v_row.status FROM public.transaction_submissions WHERE id = v_row.submission_id;\n  UPDATE public.transaction_submissions\n     SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(",
      "m20")],
  ["m21-tick-without-helper", "c06",
    (t) => editIn(t, TICK[0], TICK[1], "  IF NOT FOUND OR NOT public.can_review_submission(v_row.organization_id) THEN", "  IF NOT FOUND THEN", "m21")],
  // --- add -------------------------------------------------------------------
  ["m22-add-allows-needs-changes", "c08",
    (t) => edit(t, "v_sub.status NOT IN ('submitted', 'resubmitted', 'under_review')", "v_sub.status NOT IN ('submitted', 'resubmitted', 'under_review', 'needs_changes')", "m22")],
  ["m23-add-accepts-archived", "c08",
    (t) => editIn(t, ADD[0], ADD[1], "\n     AND t.archived_at IS NULL;", ";", "m23")],
  ["m24-add-accepts-other-org", "c08",
    (t) => editIn(t, ADD[0], ADD[1], "\n     AND t.organization_id = v_sub.organization_id", "", "m24")],
  ["m25-add-without-exists-check", "c08",
    (t) => editIn(t, ADD[0], ADD[1],
      "  IF FOUND THEN\n    RETURN jsonb_build_object('status', 'exists', 'checklist_id', v_header_id);\n  END IF;\n", "", "m25")],
  ["m26-add-without-status-gate", "c08",
    (t) => editIn(t, ADD[0], ADD[1], "  IF v_sub.status IS NULL OR v_sub.status NOT IN ('submitted', 'resubmitted', 'under_review') THEN", "  IF false THEN", "m26")],
  ["m27-add-without-helper", "c08",
    (t) => editIn(t, ADD[0], ADD[1], "  IF NOT FOUND OR NOT public.can_review_submission(v_sub.organization_id) THEN", "  IF NOT FOUND THEN", "m27")],
  // --- append-only guard -----------------------------------------------------
  ["m28-guard-without-prefix-test", "c13 c16",
    (t) => editIn(t, GUARD[0], GUARD[1],
      "  FOR i IN 0 .. v_old_len - 1 LOOP\n    IF (v_new -> i) IS DISTINCT FROM (v_old -> i) THEN\n      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';\n    END IF;\n  END LOOP;\n",
      "", "m28")],
  ["m29-guard-without-changed-by-test", "c13",
    (t) => editIn(t, GUARD[0], GUARD[1],
      "\n       OR lower(COALESCE(v_elem ->> 'changed_by', '')) IS DISTINCT FROM COALESCE(auth.uid()::text, '-') THEN",
      " THEN", "m29")],
  ["m30-guard-without-array-test", "c13",
    (t) => editIn(t, GUARD[0], GUARD[1],
      "  IF v_new IS NULL OR jsonb_typeof(v_new) <> 'array' THEN\n    RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';\n  END IF;\n", "", "m30")],
  ["m31-guard-exempts-every-caller", "c13",
    (t) => edit(t, "  IF v_role IS NULL OR v_role = 'service_role' THEN", "  IF v_role IS NULL OR v_role IN ('service_role', 'authenticated') THEN", "m31")],
  ["m32-guard-not-attached", "c13 c15",
    (t) => edit(t, "CREATE TRIGGER status_history_append_only\n  BEFORE INSERT OR UPDATE ON public.transaction_submissions\n  FOR EACH ROW EXECUTE FUNCTION public.guard_status_history_append_only();\n", "", "m32")],
  ["m33-guard-no-service-exemption", "c13",
    (t) => edit(t, "  IF v_role IS NULL OR v_role = 'service_role' THEN", "  IF v_role IS NULL THEN", "m33")],
  // --- guard: R2 (typed appends only) and R1 (INSERT) ---------------------------
  ["m36-guard-checks-typed-entries-only", "c13",
    (t) => editIn(t, GUARD[0], GUARD[1],
      "    IF jsonb_typeof(v_elem) <> 'object'\n       OR NOT (v_elem ? 'type')\n       OR lower(",
      "    IF jsonb_typeof(v_elem) = 'object' AND v_elem ? 'type'\n       AND lower(", "m36")],
  ["m37-guard-update-only", "c15 c17",
    (t) => edit(t, "  BEFORE INSERT OR UPDATE ON public.transaction_submissions", "  BEFORE UPDATE ON public.transaction_submissions", "m37")],
  ["m38-guard-insert-uses-append-test", "c17",
    (t) => editIn(t, GUARD[0], GUARD[1],
      "  IF TG_OP = 'INSERT' THEN\n    IF v_new IS NOT NULL AND v_new <> '[]'::jsonb THEN\n      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';\n    END IF;\n    RETURN NEW;\n  END IF;\n",
      "", "m38")],
  ["m39-guard-fires-after-status-trigger", "c13",
    (t) => edit(t, "CREATE TRIGGER status_history_append_only\n", "CREATE TRIGGER zz_status_history_append_only\n", "m39")],
  ["m40-guard-no-type-requirement", "c13",
    (t) => editIn(t, GUARD[0], GUARD[1], "\n       OR NOT (v_elem ? 'type')", "", "m40")],
  // --- grants ------------------------------------------------------------------
  ["m34-tick-anon-not-revoked", "c06 c15",
    (t) => edit(t, "REVOKE EXECUTE ON FUNCTION public.set_submission_checklist_reviewer_check(uuid, boolean) FROM PUBLIC, anon;",
                   "REVOKE EXECUTE ON FUNCTION public.set_submission_checklist_reviewer_check(uuid, boolean) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION public.set_submission_checklist_reviewer_check(uuid, boolean) TO anon;", "m34")],
  // --- idempotency -------------------------------------------------------------
  ["m35-constraint-added-unguarded", "c14",
    (t) => edit(t, "  IF NOT EXISTS (SELECT 1 FROM pg_constraint\n                  WHERE conname = 'submission_checklists_added_at_review_pair_check'",
                   "  IF true OR NOT EXISTS (SELECT 1 FROM pg_constraint\n                  WHERE conname = 'submission_checklists_added_at_review_pair_check'", "m35")],
];

const check = process.argv.includes("--check");
let bad = 0;
const wanted = new Set();
for (const [name, targets, fn] of MUTANTS) {
  const body = fn(MIG);
  if (body === MIG) throw new Error(`${name}: unchanged`);
  const out = `-- mutant ${name} (generated by generate.mjs from ${MIG_PATH}; do not edit)\n-- targets: ${targets}\n${body}`;
  const file = join(HERE, `${name}.sql`);
  wanted.add(`${name}.sql`);
  if (check) {
    let cur = null;
    try { cur = readFileSync(file, "utf8"); } catch { /* missing */ }
    if (cur !== out) { console.error(`stale: ${name}.sql`); bad++; }
  } else {
    writeFileSync(file, out);
  }
}
for (const f of readdirSync(HERE)) {
  if (/^m.*\.sql$/.test(f) && !wanted.has(f)) {
    if (check) { console.error(`orphan: ${f}`); bad++; } else unlinkSync(join(HERE, f));
  }
}
if (bad) process.exit(1);
console.log(`${check ? "checked" : "wrote"} ${MUTANTS.length} mutants`);
