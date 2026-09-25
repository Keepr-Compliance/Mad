#!/usr/bin/env node
// BACKLOG-3473: derive the mutant files from the SHIPPED migrations.
//
//   node supabase/tests/backlog-3473/mutants/generate.mjs            write every mutant
//   node supabase/tests/backlog-3473/mutants/generate.mjs --check    exit 1 if a file on disk differs
//   node supabase/tests/backlog-3473/mutants/generate.mjs --self-test prove edit() throws on a stale pattern
//
// Each mutant is one targeted change. Every edit of shipped text is an exact
// string replacement that THROWS when its pattern is absent or occurs more
// than once, so a mutant can never be written unchanged. Each SQL mutant ends
// with an in-database proof block that raises 'MUTATION NOT APPLIED' unless
// the change is visible in the catalog, then prints `MUTATION APPLIED: ...`;
// run.sh refuses to count a result without it.
//
// Header lines run.sh reads:
//   -- targets: c15 c16          controls that must go RED (or stay green, below)
//   -- expect: green             the named controls must stay GREEN
//   -- replaces-file: 1|2|3      a whole-file mutant (a*: run.sh apply-prod-mutants;
//                                f*: substituted for that migration in the controls)
//
// Re-run after ANY change to a migration, then run.sh mutants before recording.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const M1_PATH = "supabase/migrations/20260921101756_backlog_3473_feature_reads_honour_min_tier.sql";
const M2_PATH = "supabase/migrations/20260921101757_backlog_3473_transaction_checklists.sql";
const M3_PATH = "supabase/migrations/20260921101758_backlog_3473_retire_unused_org_columns.sql";
const M1 = read(M1_PATH);
const M2 = read(M2_PATH);
const M3 = read(M3_PATH);
const BEFORE = read("supabase/tests/backlog-3473/lib/rpc-before.sql");
// BACKLOG-3474: save_checklist_template, loaded by run.sh after file 3.
const M4_PATH = "supabase/migrations/20260924190429_backlog_3474_save_checklist_template.sql";
const M4 = read(M4_PATH);
// BACKLOG-3474 PR 3: updated_by / archived_by trigger, loaded by run.sh after file 4.
const M5_PATH = "supabase/migrations/20260924224113_backlog_3474_template_audit_fields.sql";
const M5 = read(M5_PATH);
// BACKLOG-3535: min_tier individual (M6) and the solo-owner / seed-floor file (M7),
// loaded by run.sh after file 5. M7 is the LAST definer of can_edit_checklist_templates
// and _seed_checklists_on_plan_write, so every mutant of those two starts from M7.
const M6_PATH = "supabase/migrations/20260924183422_backlog_3535_checklists_min_tier_individual.sql";
mustExist(M6_PATH);
const M7_FILE = readdirSync(join(REPO, "supabase/migrations")).filter((f) => f.endsWith("_backlog_3535_solo_checklists.sql"));
if (M7_FILE.length !== 1) throw new Error(`expected one *_backlog_3535_solo_checklists.sql, found ${M7_FILE.length}`);
// Whole-line comments dropped: M7's header quotes the ROLLBACK bodies, which
// would otherwise be the first "CREATE OR REPLACE FUNCTION" fn() finds.
const M7 = read(`supabase/migrations/${M7_FILE[0]}`)
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

function mustExist(p) {
  readFileSync(join(REPO, p));
}

/** Exact replacement; throws if `from` does not occur exactly once in `text`. */
function edit(text, from, to, label) {
  const first = text.indexOf(from);
  if (first === -1) throw new Error(`${label}: pattern not found:\n${from}`);
  if (text.indexOf(from, first + from.length) !== -1) throw new Error(`${label}: pattern occurs more than once:\n${from}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

/** Throws unless `needle` occurs in `text` (for mutants that name a shipped object). */
function mustContain(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`${label}: shipped text no longer contains:\n${needle}`);
  return needle;
}

/** The shipped CREATE OR REPLACE FUNCTION block for `name`, through its closing tag and `;`. */
function fn(text, name) {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const ends = ["\n$$;", "\n$function$;", "\n$function$\n;"]
    .map((t) => [text.indexOf(t, start), t])
    .filter(([i]) => i !== -1)
    .sort((a, b) => a[0] - b[0]);
  if (ends.length === 0) throw new Error(`function ${name}: no closing tag`);
  const [i, t] = ends[0];
  return text.slice(start, i + t.length);
}

/** The shipped DROP POLICY IF EXISTS + CREATE POLICY pair for `name`. */
function policy(text, name) {
  const start = text.indexOf(`DROP POLICY IF EXISTS ${name} ON `);
  if (start === -1) throw new Error(`policy ${name} not found`);
  const create = text.indexOf(`CREATE POLICY ${name} ON `, start);
  if (create === -1) throw new Error(`policy ${name}: no CREATE POLICY`);
  const end = text.indexOf(";\n", create);
  return text.slice(start, end + 2);
}

function proof(conditionSql, evidenceSql) {
  return `
DO $proof$
BEGIN
  IF NOT (${conditionSql}) THEN
    RAISE EXCEPTION 'MUTATION NOT APPLIED';
  END IF;
END
$proof$;
SELECT 'MUTATION APPLIED: ' || (${evidenceSql}) AS mutation;
`;
}

const def = (sig) => `pg_get_functiondef('${sig}'::regprocedure)`;
const HELPER = "public._override_above_tier(text,text,text,jsonb)";
const REJECT = "public._reject_feature_override_above_tier()";
const CAN_EDIT = "public.can_edit_checklist_templates(uuid)";
const SEED = "public._seed_org_checklist_templates(uuid)";
const SEED_TRG = "public._seed_checklists_on_plan_write()";
const RPC_SIG = {
  check_feature_access: "public.check_feature_access(uuid,text)",
  get_org_features: "public.get_org_features(uuid)",
  broker_get_org_features: "public.broker_get_org_features(uuid)",
};
const pol = (name, col) => `(SELECT ${col} FROM pg_policies WHERE schemaname = 'public' AND policyname = '${name}')`;
const COPY = ["submission_checklists", "submission_checklist_items", "submission_checklist_links", "submission_checklist_link_members"];
const SUFFIX = ["a", "b", "c", "d"];

const helper = fn(M1, "_override_above_tier");
const reject = fn(M1, "_reject_feature_override_above_tier");
const canEdit = fn(M7, "can_edit_checklist_templates");
const seed = fn(M2, "_seed_org_checklist_templates");
const seedTrg = fn(M7, "_seed_checklists_on_plan_write");
const TIER_TEST = "     AND public.tier_rank(p_plan_tier) < public.tier_rank(p_min_tier)";
const MIN_AND_TIER = "     AND p_min_tier IS NOT NULL\n" + TIER_TEST;

const mutants = {};
const add = (file, m) => {
  if (mutants[file]) throw new Error(`duplicate mutant ${file}`);
  mutants[file] = m;
};

// ---------------------------------------------------------------- file 1: the read functions
for (const [suffix, name] of [["a", "check_feature_access"], ["b", "get_org_features"], ["c", "broker_get_org_features"]]) {
  add(`m24${suffix}-${name.replace(/_/g, "-")}-guard-reverted.sql`, {
    what: `${name} restored to its pre-migration body (lib/rpc-before.sql): no min-tier guard`,
    targets: "c15 c16",
    sql: fn(BEFORE, name),
    proof: proof(`${def(RPC_SIG[name])} NOT LIKE '%_override_above_tier%'`, `'${name} has no guard call'`),
  });
}
add("m25-helper-lt-becomes-le.sql", {
  what: "the tier test uses <= (blocks an override at exactly min_tier)",
  targets: "c15 c16",
  sql: edit(helper, "public.tier_rank(p_plan_tier) < public.tier_rank(p_min_tier)", "public.tier_rank(p_plan_tier) <= public.tier_rank(p_min_tier)", "m25"),
  proof: proof(`${def(HELPER)} LIKE '%tier_rank(p_plan_tier) <= public.tier_rank(p_min_tier)%'`, `'tier test is <='`),
});
add("m26-helper-pinned-to-individual.sql", {
  what: "the guard is pinned to plan_tier = 'individual' instead of comparing ranks",
  targets: "c15",
  sql: edit(helper, TIER_TEST, "     AND p_plan_tier = 'individual'", "m26"),
  proof: proof(`${def(HELPER)} NOT LIKE '%tier_rank(p_plan_tier)%'`, `'guard pinned to individual'`),
});
add("m27-helper-literal-team.sql", {
  what: "the guard compares against the literal tier_rank('team') instead of the feature's min_tier",
  targets: "c15",
  sql: edit(helper, "< public.tier_rank(p_min_tier)", "< public.tier_rank('team')", "m27"),
  proof: proof(`${def(HELPER)} LIKE '%< public.tier_rank(''team'')%'`, `'guard uses the team literal'`),
});
add("m28-narrowing-line-live.sql", {
  what: "the helper is narrowed to transaction_checklists (the rule must cover every feature)",
  targets: "c15 c16",
  sql: edit(helper, TIER_TEST, TIER_TEST + "\n     AND p_feature_key = 'transaction_checklists'", "m28"),
  proof: proof(`${def(HELPER)} ~ '\\n +AND p_feature_key'`, `'narrowing line live'`),
});
add("m29-helper-ignores-min-tier.sql", {
  what: "the guard ignores min_tier: any ON override on an individual plan is blocked",
  targets: "c15",
  sql: edit(helper, MIN_AND_TIER, "     AND p_plan_tier = 'individual'", "m29"),
  proof: proof(`${def(HELPER)} NOT LIKE '%p_min_tier IS NOT NULL%'`, `'min_tier ignored'`),
});
add("m30-helper-blocks-when-plan-row-false.sql", {
  what: "the guard blocks an ON override whenever the plan's own row is false",
  targets: "c15",
  sql: edit(
    edit(helper, "\nIMMUTABLE\n", "\nSTABLE\n", "m30-volatility"),
    MIN_AND_TIER,
    "     AND EXISTS (SELECT 1 FROM public.plan_features pf JOIN public.plans p ON p.id = pf.plan_id\n" +
      "                  JOIN public.feature_definitions fd ON fd.id = pf.feature_id\n" +
      "                 WHERE p.tier = p_plan_tier AND fd.key = p_feature_key AND pf.enabled = false)",
    "m30",
  ),
  proof: proof(`${def(HELPER)} LIKE '%pf.enabled = false%'`, `'guard keyed on the plan row'`),
});
add("m31-helper-drops-enabled-conjunct.sql", {
  what: "the guard ignores whether the override turns the feature ON or OFF",
  targets: "c15 c25e",
  sql: edit(helper, "  SELECT COALESCE((p_override ->> 'enabled')::boolean, true)\n     AND p_min_tier IS NOT NULL", "  SELECT p_min_tier IS NOT NULL", "m31"),
  proof: proof(`${def(HELPER)} NOT LIKE '%p_override ->> ''enabled''%'`, `'enabled conjunct dropped'`),
});
add("mx01-helper-missing-enabled-is-off.sql", {
  what: "the helper treats an override with no `enabled` key as OFF (the read functions treat it as ON)",
  targets: "c25a",
  sql: edit(helper, "COALESCE((p_override ->> 'enabled')::boolean, true)", "COALESCE((p_override ->> 'enabled')::boolean, false)", "mx01"),
  proof: proof(`${def(HELPER)} LIKE '%''enabled'')::boolean, false)%'`, `'missing enabled counts as OFF'`),
});
add("m32-tier-map-without-custom.sql", {
  what: "the plan tier is ranked by an inline CASE that has no 'custom' (custom ranks 0)",
  targets: "c15",
  sql: edit(
    helper,
    "public.tier_rank(p_plan_tier) < public.tier_rank(p_min_tier)",
    "(CASE p_plan_tier WHEN 'individual' THEN 1 WHEN 'team' THEN 2 WHEN 'enterprise' THEN 3 ELSE 0 END) < public.tier_rank(p_min_tier)",
    "m32",
  ),
  proof: proof(`${def(HELPER)} LIKE '%CASE p_plan_tier%'`, `'inline tier map'`),
});

const broker = fn(M1, "broker_get_org_features");
const getOrg = fn(M1, "get_org_features");
add("m50a-broker-gains-membership-check.sql", {
  what: "broker_get_org_features refuses non-members, like get_org_features",
  targets: "c16",
  sql: edit(
    broker,
    "  -- Get org's plan\n",
    "  IF NOT EXISTS (\n    SELECT 1 FROM public.organization_members\n    WHERE user_id = auth.uid() AND organization_id = p_org_id\n" +
      "  ) THEN\n    RETURN jsonb_build_object('error', 'not_authorized', 'features', '[]'::jsonb);\n  END IF;\n\n  -- Get org's plan\n",
    "m50a",
  ),
  proof: proof(`${def(RPC_SIG.broker_get_org_features)} LIKE '%not_authorized%'`, `'broker checks membership'`),
});
add("m50b-broker-anon-return-deleted.sql", {
  what: "broker_get_org_features has no early return for an unauthenticated caller",
  targets: "c16",
  sql: edit(
    broker,
    "  -- Only require authentication (no org membership check)\n  IF auth.uid() IS NULL THEN\n    RETURN jsonb_build_object(\n" +
      "      'org_id', p_org_id,\n      'plan_name', 'none',\n      'plan_tier', 'none',\n      'features', '{}'::jsonb,\n" +
      "      'error', 'not_authenticated'\n    );\n  END IF;\n\n",
    "",
    "m50b",
  ),
  proof: proof(`${def(RPC_SIG.broker_get_org_features)} NOT LIKE '%not_authenticated%'`, `'no anon early return'`),
});
add("m50c-blocked-override-falls-to-default.sql", {
  what: "get_org_features reports a blocked override from the feature default, not the plan row",
  targets: "c16",
  sql: edit(
    getOrg,
    "      IF v_override IS NOT NULL AND NOT v_blocked THEN\n",
    "      IF v_blocked THEN\n        NULL;\n      ELSIF v_override IS NOT NULL THEN\n",
    "m50c",
  ),
  proof: proof(`${def(RPC_SIG.get_org_features)} LIKE '%IF v_blocked THEN%'`, `'blocked falls through to default'`),
});

// ---------------------------------------------------------------- file 1: the override trigger
mustContain(M1, "CREATE OR REPLACE TRIGGER reject_feature_override_above_tier", "m44");
const TRG_EXISTS = `EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_plans'::regclass AND tgname = 'reject_feature_override_above_tier')`;
const CONTINUE_BLOCK =
  "    -- Only the entries this write adds or changes are validated.\n    IF TG_OP = 'UPDATE'\n" +
  "       AND jsonb_typeof(OLD.feature_overrides) = 'object'\n" +
  "       AND (OLD.feature_overrides -> v_key) IS NOT DISTINCT FROM v_entry THEN\n      CONTINUE;\n    END IF;\n\n";
const UNCHANGED_RETURN =
  "  IF TG_OP = 'UPDATE' AND NEW.feature_overrides IS NOT DISTINCT FROM OLD.feature_overrides THEN\n    RETURN NEW;\n  END IF;\n\n";
const FIRST_IF = "BEGIN\n  IF NEW.feature_overrides IS NULL OR NEW.feature_overrides = '{}'::jsonb THEN\n    RETURN NEW;\n  END IF;\n";
add("m44-override-trigger-dropped.sql", {
  what: "the write-time override trigger is absent",
  targets: "c25a",
  sql: "DROP TRIGGER reject_feature_override_above_tier ON public.organization_plans;",
  proof: proof(`NOT ${TRG_EXISTS}`, `'override trigger absent'`),
});
add("m45-trigger-validates-every-entry.sql", {
  what: "the trigger validates every entry, not only the ones the write adds or changes",
  targets: "c25b",
  sql: edit(reject, CONTINUE_BLOCK, "", "m45"),
  proof: proof(`${def(REJECT)} NOT LIKE '%CONTINUE%'`, `'every entry validated'`),
});
add("m46-trigger-strict.sql", {
  what: "strict variant: fires on every write and validates every entry against NEW.plan_id",
  targets: "c25c",
  sql:
    edit(edit(reject, CONTINUE_BLOCK, "", "m46-continue"), UNCHANGED_RETURN, "", "m46-unchanged") +
    "\nCREATE OR REPLACE TRIGGER reject_feature_override_above_tier\n  BEFORE INSERT OR UPDATE ON public.organization_plans\n" +
    "  FOR EACH ROW\n  EXECUTE FUNCTION public._reject_feature_override_above_tier();",
  proof: proof(
    `(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.organization_plans'::regclass AND tgname = 'reject_feature_override_above_tier') NOT LIKE '%UPDATE OF%' AND ${def(REJECT)} NOT LIKE '%CONTINUE%'`,
    `'strict trigger'`,
  ),
});
add("m47-trigger-fails-before-early-return.sql", {
  what: "the trigger function raises (1/0) BEFORE its NULL / '{}' early return",
  targets: "c25d",
  sql: edit(reject, FIRST_IF, "BEGIN\n  PERFORM 1/0;\n" + FIRST_IF.slice("BEGIN\n".length), "m47"),
  proof: proof(`position('PERFORM 1/0' in ${def(REJECT)}) BETWEEN 1 AND position('IF NEW.feature_overrides IS NULL' in ${def(REJECT)})`, `'1/0 before the early return'`),
});
add("m48-trigger-fails-after-early-return.sql", {
  what: "the trigger function raises (1/0) AFTER its NULL / '{}' early return -- first sign-in must stay unaffected",
  targets: "c25d",
  expect: "green",
  sql: edit(reject, FIRST_IF, FIRST_IF + "\n  PERFORM 1/0;\n", "m48"),
  proof: proof(`position('PERFORM 1/0' in ${def(REJECT)}) > position('IF NEW.feature_overrides IS NULL' in ${def(REJECT)})`, `'1/0 after the early return'`),
});
add("m49-trigger-returns-null-early.sql", {
  what: "the trigger returns NULL on its early-return path (a BEFORE trigger returning NULL skips the row)",
  targets: "c25d c18",
  sql: edit(reject, FIRST_IF, FIRST_IF.replace("    RETURN NEW;", "    RETURN NULL;"), "m49"),
  proof: proof(`${def(REJECT)} LIKE '%RETURN NULL%'`, `'early return is RETURN NULL'`),
});

// ---------------------------------------------------------------- file 2: templates
const tSelect = policy(M2, "checklist_templates_select_member");
const iSelect = policy(M2, "checklist_template_items_select_member");
add("m01-templates-select-open.sql", {
  what: "checklist_templates SELECT policy USING (true)",
  targets: "c01",
  sql: edit(tSelect, "  USING (checklist_templates.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid()))));", "  USING (true);", "m01"),
  proof: proof(`${pol("checklist_templates_select_member", "qual")} = 'true'`, `'templates readable by any authenticated user'`),
});
add("m02-items-select-open.sql", {
  what: "checklist_template_items SELECT policy USING (true)",
  targets: "c01",
  sql: edit(
    iSelect,
    "  USING (EXISTS (\n    SELECT 1\n      FROM public.checklist_templates t\n     WHERE t.id = checklist_template_items.template_id\n" +
      "       AND t.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid())))\n  ));",
    "  USING (true);",
    "m02",
  ),
  proof: proof(`${pol("checklist_template_items_select_member", "qual")} = 'true'`, `'items readable by any authenticated user'`),
});
mustContain(M2, "REVOKE ALL ON public.checklist_templates FROM anon, authenticated;", "m03");
add("m03-anon-select-templates.sql", {
  what: "SELECT on checklist_templates granted to anon",
  targets: "c01a",
  sql: "GRANT SELECT ON public.checklist_templates TO anon;",
  proof: proof(`has_table_privilege('anon', 'public.checklist_templates', 'SELECT')`, `'anon holds SELECT'`),
});
const ROLES = "m.role IN ('broker', 'admin', 'it_admin')";
add("m04-helper-admits-agent.sql", {
  what: "can_edit_checklist_templates admits the agent role",
  targets: "c02 c41",
  sql: edit(canEdit, ROLES, "m.role IN ('broker', 'admin', 'it_admin', 'agent')", "m04"),
  proof: proof(`${def(CAN_EDIT)} LIKE '%''agent''%'`, `'agent admitted'`),
});
add("m05-helper-role-anywhere.sql", {
  what: "can_edit_checklist_templates tests 'editor role in ANY org' and 'member of this org' separately",
  targets: "c03",
  sql: edit(
    canEdit,
    "            WHERE m.organization_id = p_org_id\n              AND m.user_id = (SELECT auth.uid())\n              AND (m.role IN ('broker', 'admin', 'it_admin')\n                   OR o.personal_owner_user_id = m.user_id)\n         )",
    "            WHERE m.user_id = (SELECT auth.uid())\n              AND (m.role IN ('broker', 'admin', 'it_admin')\n                   OR o.personal_owner_user_id = m.user_id)\n         )\n" +
      "     AND EXISTS (\n           SELECT 1\n             FROM public.organization_members m2\n            WHERE m2.organization_id = p_org_id\n" +
      "              AND m2.user_id = (SELECT auth.uid())\n         )",
    "m05",
  ),
  proof: proof(`${def(CAN_EDIT)} LIKE '%m2.organization_id = p_org_id%'`, `'role and membership tested separately'`),
});
for (const [suffix, role, list] of [
  ["a", "broker", "('admin', 'it_admin')"],
  ["b", "admin", "('broker', 'it_admin')"],
  ["c", "it_admin", "('broker', 'admin')"],
]) {
  add(`m06${suffix}-helper-without-${role.replace("_", "-")}.sql`, {
    what: `can_edit_checklist_templates no longer admits ${role}`,
    targets: "c04",
    sql: edit(canEdit, ROLES, `m.role IN ${list}`, `m06${suffix}`),
    proof: proof(`${def(CAN_EDIT)} NOT LIKE '%''${role}''%'`, `'${role} removed'`),
  });
}
add("m07-helper-without-entitlement.sql", {
  what: "can_edit_checklist_templates does not check the organization's entitlement",
  targets: "c05 c41",
  sql: edit(
    canEdit,
    "\n     AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);",
    ";",
    "m07",
  ),
  proof: proof(`${def(CAN_EDIT)} NOT LIKE '%check_feature_access%'`, `'entitlement term dropped'`),
});
add("m08a-templates-delete-granted.sql", {
  what: "DELETE on checklist_templates granted (no DELETE policy)",
  targets: "c06",
  sql: "GRANT DELETE ON public.checklist_templates TO authenticated;",
  proof: proof(`has_table_privilege('authenticated', 'public.checklist_templates', 'DELETE')`, `'authenticated holds DELETE'`),
});
add("m08b-templates-delete-policy.sql", {
  what: "DELETE on checklist_templates granted, plus an editor DELETE policy",
  targets: "c06",
  sql:
    "GRANT DELETE ON public.checklist_templates TO authenticated;\n" +
    "CREATE POLICY zz_mutant_templates_delete ON public.checklist_templates FOR DELETE TO authenticated\n" +
    "  USING (public.can_edit_checklist_templates(checklist_templates.organization_id));",
  proof: proof(`EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'zz_mutant_templates_delete')`, `'editor DELETE policy present'`),
});
add("m09a-templates-update-whole-table.sql", {
  what: "UPDATE on the whole of checklist_templates granted (every column)",
  targets: "c07",
  sql: "GRANT UPDATE ON public.checklist_templates TO authenticated;",
  proof: proof(`has_column_privilege('authenticated', 'public.checklist_templates', 'seed_key', 'UPDATE')`, `'seed_key updatable'`),
});
add("m09b-templates-insert-whole-table.sql", {
  what: "INSERT on the whole of checklist_templates granted (every column)",
  targets: "c07",
  sql: "GRANT INSERT ON public.checklist_templates TO authenticated;",
  proof: proof(`has_column_privilege('authenticated', 'public.checklist_templates', 'seed_key', 'INSERT')`, `'seed_key insertable'`),
});

// ---------------------------------------------------------------- file 2: the submitted copy
const READERS =
  "       AND (ts.submitted_by = (SELECT auth.uid())\n            OR EXISTS (\n              SELECT 1\n" +
  "                FROM public.organization_members om\n               WHERE om.organization_id = ts.organization_id\n" +
  "                 AND om.user_id = (SELECT auth.uid())\n                 AND om.role IN ('broker', 'admin')\n            ))";
// m10a-d are EQUIVALENT under production's schema (measured in phase ii): each
// copy policy's EXISTS reads transaction_submissions as the caller, and that
// table's own SELECT policy (FORCE RLS) admits exactly the submitter and the
// org's brokers and admins -- the copy's reader set. An it_admin or a second
// agent never sees the ts row, so "any member" admits nobody new and C8 stays
// green. They are pinned GREEN: if transaction_submissions' SELECT ever widens,
// they turn red and the copy's own role term has become load-bearing.
// m10e-h are the discriminating mutants for C8: USING (true) has no
// transaction_submissions reference, so its RLS cannot mask the change.
COPY.forEach((t, i) => {
  add(`m10${SUFFIX[i]}-${t.replace(/_/g, "-")}-select-any-member.sql`, {
    what: `${t} SELECT admits any member of the submission's organization -- equivalent today (transaction_submissions' own SELECT masks it), so C8 must stay GREEN`,
    targets: "c08",
    expect: "green",
    sql: edit(
      policy(M2, `${t}_select`),
      READERS,
      "       AND (ts.submitted_by = (SELECT auth.uid())\n            OR ts.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid()))))",
      `m10${SUFFIX[i]}`,
    ),
    proof: proof(`${pol(`${t}_select`, "qual")} NOT LIKE '%broker%'`, `'${t} readable by any member'`),
  });
});
COPY.forEach((t, i) => {
  const shipped = policy(M2, `${t}_select`);
  const at = shipped.indexOf("  USING (");
  if (at === -1 || shipped.indexOf("  USING (", at + 1) !== -1) throw new Error(`m10 open ${t}: USING clause not found exactly once`);
  add(`m10${["e", "f", "g", "h"][i]}-${t.replace(/_/g, "-")}-select-open.sql`, {
    what: `${t} SELECT open to every signed-in user (USING true: no transaction_submissions reference to mask it)`,
    targets: "c08",
    sql: shipped.slice(0, at) + "  USING (true);\n",
    proof: proof(`${pol(`${t}_select`, "qual")} = 'true'`, `'${t} readable by every signed-in user'`),
  });
});
const headerInsert = policy(M2, "submission_checklists_insert");
add("m11-header-insert-without-status.sql", {
  what: "submission_checklists INSERT without the 'uploading' term",
  targets: "c09",
  sql: edit(headerInsert, "AND ts.status = 'uploading'", "AND true", "m11"),
  proof: proof(`${pol("submission_checklists_insert", "with_check")} NOT LIKE '%uploading%'`, `'header status term dropped'`),
});
add("m12-header-insert-without-submitter.sql", {
  what: "submission_checklists INSERT without the submitter term",
  targets: "c09",
  sql: edit(headerInsert, "AND ts.submitted_by = (SELECT auth.uid())", "AND true", "m12"),
  proof: proof(`${pol("submission_checklists_insert", "with_check")} NOT LIKE '%submitted_by%'`, `'header submitter term dropped'`),
});
COPY.slice(1).forEach((t, i) => {
  add(`m13${SUFFIX[i]}-${t.replace(/_/g, "-")}-insert-without-status.sql`, {
    what: `${t} INSERT without the 'uploading' term`,
    targets: "c09",
    sql: edit(policy(M2, `${t}_insert`), "AND ts.status = 'uploading'", "AND true", `m13${SUFFIX[i]}`),
    proof: proof(`${pol(`${t}_insert`, "with_check")} NOT LIKE '%uploading%'`, `'${t} status term dropped'`),
  });
});
add("m14-header-insert-without-entitlement.sql", {
  what: "submission_checklists INSERT without the check_feature_access term",
  targets: "c09b",
  sql: edit(
    headerInsert,
    "AND COALESCE((public.check_feature_access(ts.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false)",
    "AND true",
    "m14",
  ),
  proof: proof(`${pol("submission_checklists_insert", "with_check")} NOT LIKE '%check_feature_access%'`, `'header entitlement term dropped'`),
});
COPY.forEach((t, i) => {
  mustContain(M2, `CREATE POLICY ${t}_insert ON public.${t}`, `m15${SUFFIX[i]}`);
  add(`m15${SUFFIX[i]}-${t.replace(/_/g, "-")}-insert-refuses-all.sql`, {
    what: `${t} INSERT policy WITH CHECK (false) (too strict: refuses the submitter)`,
    targets: "c09p",
    sql: `DROP POLICY IF EXISTS ${t}_insert ON public.${t};\nCREATE POLICY ${t}_insert ON public.${t} FOR INSERT TO authenticated WITH CHECK (false);`,
    proof: proof(`${pol(`${t}_insert`, "with_check")} = 'false'`, `'${t} insert refuses everyone'`),
  });
  mustContain(M2, `GRANT SELECT, INSERT ON public.${t} `, `m51${SUFFIX[i]}`);
  add(`m51${SUFFIX[i]}-${t.replace(/_/g, "-")}-insert-not-granted.sql`, {
    what: `INSERT on ${t} not granted to authenticated`,
    targets: "c09p",
    sql: `REVOKE INSERT ON public.${t} FROM authenticated;`,
    proof: proof(`NOT has_table_privilege('authenticated', 'public.${t}', 'INSERT')`, `'${t} INSERT revoked'`),
  });
  add(`m17${SUFFIX[i]}-${t.replace(/_/g, "-")}-update-delete-granted.sql`, {
    what: `UPDATE and DELETE on ${t} granted, with submitter UPDATE / DELETE policies`,
    targets: "c10",
    sql:
      `GRANT UPDATE, DELETE ON public.${t} TO authenticated;\n` +
      `CREATE POLICY zz_mutant_${t}_update ON public.${t} FOR UPDATE TO authenticated\n` +
      `  USING (EXISTS (SELECT 1 FROM public.transaction_submissions ts WHERE ts.id = ${t}.submission_id AND ts.submitted_by = (SELECT auth.uid())));\n` +
      `CREATE POLICY zz_mutant_${t}_delete ON public.${t} FOR DELETE TO authenticated\n` +
      `  USING (EXISTS (SELECT 1 FROM public.transaction_submissions ts WHERE ts.id = ${t}.submission_id AND ts.submitted_by = (SELECT auth.uid())));`,
    proof: proof(`has_table_privilege('authenticated', 'public.${t}', 'UPDATE')`, `'${t} updatable by the submitter'`),
  });
});
const membersInsert = policy(M2, "submission_checklist_link_members_insert");
add("m18a-member-attachment-any-submission.sql", {
  what: "members INSERT without the attachment same-submission term",
  targets: "c11",
  sql: edit(membersInsert, "AND a.submission_id = submission_checklist_link_members.submission_id", "AND true", "m18a"),
  proof: proof(`${pol("submission_checklist_link_members_insert", "with_check")} NOT LIKE '%a.submission_id%'`, `'attachment same-submission term dropped'`),
});
add("m18b-member-message-any-submission.sql", {
  what: "members INSERT without the message same-submission term",
  targets: "c11",
  sql: edit(membersInsert, "AND m.submission_id = submission_checklist_link_members.submission_id", "AND true", "m18b"),
  proof: proof(`${pol("submission_checklist_link_members_insert", "with_check")} NOT LIKE '%m.submission_id%'`, `'message same-submission term dropped'`),
});
add("m19-member-any-channel.sql", {
  what: "members INSERT without the channel = 'email' term",
  targets: "c11c",
  sql: edit(membersInsert, "AND m.channel = 'email'", "AND true", "m19"),
  proof: proof(`${pol("submission_checklist_link_members_insert", "with_check")} NOT LIKE '%channel%'`, `'channel term dropped'`),
});
mustContain(M2, "CONSTRAINT submission_checklist_link_members_target_check CHECK", "m20");
add("m20-member-target-check-dropped.sql", {
  what: "the members kind / target CHECK dropped",
  targets: "c12a",
  sql: "ALTER TABLE public.submission_checklist_link_members DROP CONSTRAINT submission_checklist_link_members_target_check;",
  proof: proof(`NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submission_checklist_link_members_target_check')`, `'target CHECK absent'`),
});
mustContain(M2, "CONSTRAINT submission_checklist_link_members_link_fkey FOREIGN KEY (link_id, submission_id, kind)", "m21");
add("m21-member-link-fk-without-kind.sql", {
  what: "the members -> links FK ignores kind",
  targets: "c12b",
  sql:
    "ALTER TABLE public.submission_checklist_links ADD CONSTRAINT zz_mutant_links_id_submission_id_key UNIQUE (id, submission_id);\n" +
    "ALTER TABLE public.submission_checklist_link_members DROP CONSTRAINT submission_checklist_link_members_link_fkey;\n" +
    "ALTER TABLE public.submission_checklist_link_members ADD CONSTRAINT submission_checklist_link_members_link_fkey\n" +
    "  FOREIGN KEY (link_id, submission_id) REFERENCES public.submission_checklist_links(id, submission_id) ON DELETE CASCADE;",
  proof: proof(
    `(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'submission_checklist_link_members_link_fkey') NOT LIKE '%kind%'`,
    `(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'submission_checklist_link_members_link_fkey')`,
  ),
});
for (const [suffix, table, con, cols, parent] of [
  ["a", "submission_checklist_items", "submission_checklist_items_checklist_fkey", "submission_checklist_id", "submission_checklists"],
  ["b", "submission_checklist_links", "submission_checklist_links_item_fkey", "submission_checklist_item_id", "submission_checklist_items"],
  ["c", "submission_checklist_link_members", "submission_checklist_link_members_link_fkey", "link_id", "submission_checklist_links"],
]) {
  mustContain(M2, `CONSTRAINT ${con} FOREIGN KEY (${cols}, submission_id`, `m22${suffix}`);
  add(`m22${suffix}-${table.replace(/_/g, "-")}-fk-single-column.sql`, {
    what: `${table}'s composite FK replaced by a single-column FK on ${cols}`,
    targets: "c13",
    sql:
      `ALTER TABLE public.${table} DROP CONSTRAINT ${con};\n` +
      `ALTER TABLE public.${table} ADD CONSTRAINT ${con} FOREIGN KEY (${cols}) REFERENCES public.${parent}(id) ON DELETE CASCADE;`,
    proof: proof(
      `(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '${con}') NOT LIKE '%submission_id%'`,
      `(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '${con}')`,
    ),
  });
}
mustContain(M2, "CONSTRAINT submission_checklists_submission_id_fkey FOREIGN KEY (submission_id)", "m23");
add("m23-header-fk-no-action.sql", {
  what: "the header -> transaction_submissions FK is ON DELETE NO ACTION",
  targets: "c14",
  sql:
    "ALTER TABLE public.submission_checklists DROP CONSTRAINT submission_checklists_submission_id_fkey;\n" +
    "ALTER TABLE public.submission_checklists ADD CONSTRAINT submission_checklists_submission_id_fkey\n" +
    "  FOREIGN KEY (submission_id) REFERENCES public.transaction_submissions(id) ON DELETE NO ACTION;",
  proof: proof(
    `(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'submission_checklists_submission_id_fkey') NOT LIKE '%CASCADE%'`,
    `(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'submission_checklists_submission_id_fkey')`,
  ),
});

// ---------------------------------------------------------------- file 2: seeding
add("m33-seed-without-on-conflict.sql", {
  what: "the seed copy has no ON CONFLICT",
  targets: "c17",
  sql: edit(seed, "\n    ON CONFLICT (organization_id, seed_key) WHERE seed_key IS NOT NULL DO NOTHING", "", "m33"),
  proof: proof(`${def(SEED)} NOT LIKE '%ON CONFLICT%'`, `'seed has no ON CONFLICT'`),
});
add("m34-seed-items-for-every-catalogue-row.sql", {
  what: "the seed copy inserts items for every seeded template of the org, not only the ones it just inserted",
  targets: "c17",
  sql: edit(
    seed,
    "      FROM inserted i\n",
    "      FROM (SELECT t.id, t.seed_key FROM public.checklist_templates t\n             WHERE t.organization_id = p_org_id AND t.seed_key IS NOT NULL) i\n",
    "m34",
  ),
  proof: proof(`${def(SEED)} LIKE '%t.organization_id = p_org_id AND t.seed_key IS NOT NULL%'`, `'items for every seeded template'`),
});
mustContain(M2, "CREATE UNIQUE INDEX IF NOT EXISTS checklist_templates_org_seed_key_key", "m35");
add("m35-seed-unique-index-dropped.sql", {
  what: "the (organization_id, seed_key) partial unique index dropped",
  targets: "c17",
  sql: "DROP INDEX public.checklist_templates_org_seed_key_key;",
  proof: proof(`to_regclass('public.checklist_templates_org_seed_key_key') IS NULL`, `'seed idempotency index absent'`),
});
// BACKLOG-3535: the trigger now comes from M7 (floor = feature_definitions.min_tier).
// m36 retargeted to c42 (C42.1 is the input that separates "no floor" from the
// min_tier floor; C18 now expects u_p seeded either way). m37 (`< 1`) retired: on
// every real tier it equals a hard-coded 'individual' floor, which is m75 below.
// m39 retired: with min_tier individual no real tier sits below the floor at first
// sign-in, so "a failure after the floor leaves sign-in untouched" no longer has an
// input -- a seed failure now DOES roll back ensure_personal_organization (m38 and
// the migration header say so).
const SEED_FLOOR =
  "     < public.tier_rank((SELECT fd.min_tier FROM public.feature_definitions fd\n                          WHERE fd.key = 'transaction_checklists')) THEN";
const SEED_EARLY =
  "  IF public.tier_rank((SELECT p.tier FROM public.plans p WHERE p.id = NEW.plan_id))\n" + SEED_FLOOR + "\n    RETURN NULL;\n  END IF;\n";
add("m36-seed-trigger-without-tier-test.sql", {
  what: "the seed trigger seeds every plan write (tier early return removed)",
  targets: "c42",
  sql: edit(seedTrg, SEED_EARLY, "", "m36"),
  proof: proof(`${def(SEED_TRG)} NOT LIKE '%tier_rank%'`, `'no tier test'`),
});
add("m38-seed-trigger-fails-before-tier-test.sql", {
  what: "the seed trigger raises (1/0) BEFORE its tier early return",
  targets: "c18",
  sql: edit(seedTrg, "BEGIN\n" + SEED_EARLY, "BEGIN\n  PERFORM 1/0;\n" + SEED_EARLY, "m38"),
  proof: proof(`position('PERFORM 1/0' in ${def(SEED_TRG)}) BETWEEN 1 AND position('tier_rank' in ${def(SEED_TRG)})`, `'1/0 before the tier test'`),
});
add("m40-seed-function-granted.sql", {
  what: "EXECUTE on _seed_org_checklist_templates granted to authenticated",
  targets: "c19",
  sql: `GRANT EXECUTE ON FUNCTION ${SEED} TO authenticated;`,
  proof: proof(`has_function_privilege('authenticated', '${SEED}', 'EXECUTE')`, `'seed function executable'`),
});
add("m41-catalogue-select-granted.sql", {
  what: "SELECT on checklist_seed_templates granted to authenticated",
  targets: "c19",
  sql: "GRANT SELECT ON public.checklist_seed_templates TO authenticated;",
  proof: proof(`has_table_privilege('authenticated', 'public.checklist_seed_templates', 'SELECT')`, `'catalogue selectable'`),
});
mustContain(M2, "CONSTRAINT checklist_seed_templates_items_check CHECK", "m42");
add("m42-catalogue-items-check-dropped.sql", {
  what: "the catalogue items CHECK (the validator) dropped",
  targets: "c24",
  sql: "ALTER TABLE public.checklist_seed_templates DROP CONSTRAINT checklist_seed_templates_items_check;",
  proof: proof(`NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_seed_templates_items_check')`, `'items CHECK absent'`),
});
mustContain(M2, "CONSTRAINT checklist_seed_templates_name_check CHECK", "m43");
add("m43-catalogue-name-check-dropped.sql", {
  what: "the catalogue name CHECK dropped",
  targets: "c24",
  sql: "ALTER TABLE public.checklist_seed_templates DROP CONSTRAINT checklist_seed_templates_name_check;",
  proof: proof(`NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_seed_templates_name_check')`, `'name CHECK absent'`),
});

// ---------------------------------------------------------------- BACKLOG-3535: solo owner, seed floor
// The likely wrong implementations named in the plan (pm_comments 2dd91e1a) and
// SR review (pm_comments 1ff927e5). "Owner clause outside the membership EXISTS"
// is NOT here: check_feature_access refuses a non-member first, so no database
// input separates it from the shipped rule (SR ruling); the CI text tripwire
// solo-checklists-3535.test.ts is its control.
const OWNER = "                   OR o.personal_owner_user_id = m.user_id)";
add("m71-helper-owner-of-any-org.sql", {
  what: "can_edit_checklist_templates admits a member of p_org_id who owns ANY personal organization",
  targets: "c41",
  sql: edit(canEdit, OWNER, "                   OR EXISTS (SELECT 1 FROM public.organizations x WHERE x.personal_owner_user_id = (SELECT auth.uid())))", "m71"),
  proof: proof(`${def(CAN_EDIT)} LIKE '%x.personal_owner_user_id = (SELECT auth.uid())%'`, `'owner of any org'`),
});
add("m72-helper-any-member-of-personal.sql", {
  what: "can_edit_checklist_templates admits any member of a personal organization, owner or not",
  targets: "c41",
  sql: edit(canEdit, OWNER, "                   OR o.personal_owner_user_id IS NOT NULL)", "m72"),
  proof: proof(`${def(CAN_EDIT)} LIKE '%personal_owner_user_id IS NOT NULL%'`, `'any member of a personal org'`),
});
add("m73-helper-member-of-some-personal-org.sql", {
  what: "can_edit_checklist_templates admits a member of p_org_id who belongs to SOME personal organization",
  targets: "c41",
  sql: edit(
    canEdit,
    OWNER,
    "                   OR EXISTS (SELECT 1 FROM public.organization_members pm JOIN public.organizations po ON po.id = pm.organization_id\n" +
      "                               WHERE pm.user_id = (SELECT auth.uid()) AND po.personal_owner_user_id IS NOT NULL))",
    "m73",
  ),
  proof: proof(`${def(CAN_EDIT)} LIKE '%po.personal_owner_user_id IS NOT NULL%'`, `'member of some personal org'`),
});
add("m74-helper-owner-clause-removed.sql", {
  what: "can_edit_checklist_templates without the owner clause (the item not implemented)",
  targets: "c41",
  sql: edit(canEdit, "              AND (m.role IN ('broker', 'admin', 'it_admin')\n" + OWNER, "              AND (m.role IN ('broker', 'admin', 'it_admin'))", "m74"),
  proof: proof(`${def(CAN_EDIT)} NOT LIKE '%personal_owner_user_id%'`, `'owner clause absent'`),
});
add("m75-seed-floor-hardcoded-individual.sql", {
  what: "the seed floor is the literal tier_rank('individual') instead of the feature's min_tier",
  targets: "c42",
  sql: edit(seedTrg, SEED_FLOOR, "     < public.tier_rank('individual') THEN", "m75"),
  proof: proof(`${def(SEED_TRG)} LIKE '%tier_rank(''individual'')%'`, `'floor literal individual'`),
});
add("m76-seed-floor-left-at-team.sql", {
  what: "the seed floor left at the literal tier_rank('team')",
  targets: "c42",
  sql: edit(seedTrg, SEED_FLOOR, "     < public.tier_rank('team') THEN", "m76"),
  proof: proof(`${def(SEED_TRG)} LIKE '%tier_rank(''team'')%'`, `'floor literal team'`),
});
add("m77-seed-floor-le-instead-of-lt.sql", {
  what: "the seed floor uses <= (an org exactly at min_tier is not seeded)",
  targets: "c42",
  sql: edit(seedTrg, SEED_FLOOR, SEED_FLOOR.replace("     < public", "     <= public"), "m77"),
  proof: proof(`${def(SEED_TRG)} LIKE '%<= public.tier_rank((SELECT fd.min_tier%'`, `'floor <='`),
});

// ---------------------------------------------------------------- whole-file mutants
// ---------------------------------------------------------------- BACKLOG-3474: save_checklist_template
// Each mutant is the likely wrong implementation named in the SR plan review
// (pm_comments 527926ff, ruling 6). The function is re-created from the shipped
// text with one exact edit; the proof reads the definition back.
const SAVE = "public.save_checklist_template(uuid,uuid,text,text,text,jsonb)";
const save = fn(M4, "save_checklist_template");
const AUTH_CHECK =
  "  IF NOT public.can_edit_checklist_templates(p_org_id) THEN\n    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';\n  END IF;\n\n";
const STALE_PRED = "       AND t.updated_at = p_expected_updated_at::timestamptz\n";
const TPL_UPDATE =
  "    UPDATE public.checklist_templates AS t\n" +
  "       SET name = btrim(p_name),\n" +
  "           description = NULLIF(btrim(p_description), '')\n" +
  "     WHERE t.id = p_template_id\n" +
  "       AND t.organization_id = p_org_id\n" +
  STALE_PRED +
  "    RETURNING t.id, t.updated_at INTO v_template_id, v_updated_at;\n";
const noAuth = edit(save, AUTH_CHECK, "", "m52");

add("m52-save-without-authority-check.sql", {
  what: "BACKLOG-3474 A9: save_checklist_template without its up-front can_edit_checklist_templates check",
  targets: "c35",
  sql: noAuth,
  proof: proof(`${def(SAVE)} NOT LIKE '%can_edit_checklist_templates%'`, `'no authority check'`),
});
add("m53-save-definer-without-authority-check.sql", {
  what: "BACKLOG-3474 M15b: no authority check AND SECURITY DEFINER (RLS no longer applies to the writes)",
  targets: "c35",
  sql: edit(noAuth, "SECURITY INVOKER", "SECURITY DEFINER", "m53"),
  proof: proof(`${def(SAVE)} NOT LIKE '%can_edit_checklist_templates%' AND (SELECT prosecdef FROM pg_proc WHERE oid = '${SAVE}'::regprocedure)`,
               `'no authority check, security definer'`),
});
add("m54-save-security-definer.sql", {
  what: "BACKLOG-3474 M15: save_checklist_template made SECURITY DEFINER (authority check kept)",
  targets: "c34",
  sql: edit(save, "SECURITY INVOKER", "SECURITY DEFINER", "m54"),
  proof: proof(`(SELECT prosecdef FROM pg_proc WHERE oid = '${SAVE}'::regprocedure)`, `'security definer'`),
});
add("m55-save-anon-not-revoked.sql", {
  what: "BACKLOG-3474 A7: the file replayed on a fresh function with `anon` dropped from the REVOKE",
  targets: "c34",
  sql:
    "DROP FUNCTION public.save_checklist_template(uuid, uuid, text, text, text, jsonb);\n" +
    edit(M4, "FROM PUBLIC, anon;", "FROM PUBLIC;", "m55"),
  proof: proof(`has_function_privilege('anon', '${SAVE}', 'EXECUTE')`, `'anon can execute'`),
});
add("m56-save-item-insert-swallows-errors.sql", {
  what: "BACKLOG-3474 A4: the new-item INSERT wrapped in EXCEPTION WHEN OTHERS THEN RETURN",
  targets: "c27 c28",
  sql: edit(
    edit(save, "  INSERT INTO public.checklist_template_items\n", "  BEGIN\n  INSERT INTO public.checklist_template_items\n", "m56a"),
    "   WHERE e.value->>'id' IS NULL;\n",
    "   WHERE e.value->>'id' IS NULL;\n  EXCEPTION WHEN OTHERS THEN RETURN;\n  END;\n",
    "m56b",
  ),
  proof: proof(`${def(SAVE)} LIKE '%EXCEPTION WHEN OTHERS THEN RETURN%'`, `'item insert swallows errors'`),
});
add("m57-save-without-stale-predicate.sql", {
  what: "BACKLOG-3474 M17: the template UPDATE no longer compares updated_at with the caller's token",
  targets: "c29 c30",
  sql: edit(save, STALE_PRED, "", "m57"),
  proof: proof(`${def(SAVE)} NOT LIKE '%p_expected_updated_at::timestamptz%'`, `'no stale predicate'`),
});
add("m58-save-stale-at-milliseconds.sql", {
  what: "BACKLOG-3474 M17: the stale check compares at millisecond precision",
  targets: "c29",
  sql: edit(save, STALE_PRED,
    "       AND date_trunc('milliseconds', t.updated_at) = date_trunc('milliseconds', p_expected_updated_at::timestamptz)\n", "m58"),
  proof: proof(`${def(SAVE)} LIKE '%date_trunc(''milliseconds''%'`, `'stale check at ms'`),
});
add("m59-save-skips-update-when-header-unchanged.sql", {
  what: "BACKLOG-3474 A2: the template UPDATE is skipped when name and description are unchanged",
  targets: "c30",
  sql: edit(save, TPL_UPDATE,
    "    SELECT t.id, t.updated_at INTO v_template_id, v_updated_at\n" +
    "      FROM public.checklist_templates AS t\n" +
    "     WHERE t.id = p_template_id AND t.organization_id = p_org_id\n" +
    "       AND t.updated_at = p_expected_updated_at::timestamptz\n" +
    "       AND t.name = btrim(p_name)\n" +
    "       AND t.description IS NOT DISTINCT FROM NULLIF(btrim(p_description), '');\n" +
    "    IF v_template_id IS NULL THEN\n" + TPL_UPDATE + "    END IF;\n", "m59"),
  proof: proof(`${def(SAVE)} LIKE '%IS NOT DISTINCT FROM NULLIF(btrim(p_description)%'`, `'update skipped when header unchanged'`),
});
add("m60-save-returns-callers-token.sql", {
  what: "BACKLOG-3474 A3: the function hands back the caller's token instead of the new updated_at",
  targets: "c31",
  sql: edit(save, "RETURN QUERY SELECT v_template_id, to_json(v_updated_at) #>> '{}';",
    "RETURN QUERY SELECT v_template_id, coalesce(p_expected_updated_at, to_json(v_updated_at) #>> '{}');", "m60"),
  proof: proof(`${def(SAVE)} LIKE '%coalesce(p_expected_updated_at%'`, `'returns the caller token'`),
});
add("m61-save-item-update-any-template.sql", {
  what: "BACKLOG-3474 M16: the item UPDATE drops `i.template_id = v_template_id`",
  targets: "c32",
  sql: edit(save, "     AND i.id = (e.value->>'id')::uuid\n     AND i.template_id = v_template_id;",
    "     AND i.id = (e.value->>'id')::uuid;", "m61"),
  proof: proof(`${def(SAVE)} NOT LIKE '%AND i.template_id = v_template_id%'`, `'item update not scoped to the template'`),
});
add("m62-save-counts-distinct-ids.sql", {
  what: "BACKLOG-3474 A5: the id count is DISTINCT, so a repeated id matches the updated-row count",
  targets: "c32",
  sql: edit(save, "  SELECT count(*) INTO v_id_elems", "  SELECT count(DISTINCT e.value->>'id') INTO v_id_elems", "m62"),
  proof: proof(`${def(SAVE)} LIKE '%count(DISTINCT%'`, `'distinct id count'`),
});
add("m63-save-without-item-cap.sql", {
  what: "BACKLOG-3474 A6: the 1..200 item bound removed from the function (portal-only cap)",
  targets: "c33",
  sql: edit(save, "     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 200\n", "", "m63"),
  proof: proof(`${def(SAVE)} NOT LIKE '%NOT BETWEEN 1 AND 200%'`, `'no item cap'`),
});
add("m64-save-kept-ids-include-nulls.sql", {
  what: "BACKLOG-3474 M18: the kept-id array is built from every element, NULL ids included",
  targets: "c36",
  sql: edit(save, "            FROM jsonb_array_elements(p_items) AS e(value)\n            WHERE e.value->>'id' IS NOT NULL));",
    "            FROM jsonb_array_elements(p_items) AS e(value)));", "m64"),
  proof: proof(`${def(SAVE)} LIKE '%AS e(value)));%'`, `'kept ids include NULLs'`),
});

// ---------------------------------------------------------------- BACKLOG-3474 PR 3: audit fields
// The likely wrong implementations of the updated_by / archived_by trigger.
const AUDIT = "public._checklist_templates_audit()";
const audit = fn(M5, "_checklist_templates_audit");
const AUDIT_TRG = M5.slice(M5.indexOf("CREATE OR REPLACE TRIGGER checklist_templates_audit"));
mustContain(AUDIT_TRG, "BEFORE UPDATE ON public.checklist_templates", "audit trigger");
const trgdef = `(SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgname = 'checklist_templates_audit' AND t.tgrelid = 'public.checklist_templates'::regclass)`;

add("m65-audit-updated-by-never-set.sql", {
  what: "BACKLOG-3474 PR 3: the trigger never sets updated_by",
  targets: "c37 c38",
  sql: edit(audit, "  NEW.updated_by := auth.uid();\n", "", "m65"),
  proof: proof(`${def(AUDIT)} NOT LIKE '%NEW.updated_by := auth.uid()%'`, `'updated_by never set'`),
});
add("m66-audit-restore-keeps-archiver.sql", {
  what: "BACKLOG-3474 PR 3: restore keeps the stale archived_by",
  targets: "c38",
  sql: edit(audit, "  IF NEW.archived_at IS NULL THEN\n    NEW.archived_by := NULL;\n",
    "  IF NEW.archived_at IS NULL THEN\n    NEW.archived_by := OLD.archived_by;\n", "m66"),
  proof: proof(`${def(AUDIT)} NOT LIKE '%NEW.archived_by := NULL%'`, `'restore keeps archived_by'`),
});
add("m67-audit-trigger-archive-path-only.sql", {
  what: "BACKLOG-3474 PR 3: the trigger fires only when archived_at is in the UPDATE (archive path only)",
  targets: "c37 c38",
  sql: edit(AUDIT_TRG, "BEFORE UPDATE ON public.checklist_templates", "BEFORE UPDATE OF archived_at ON public.checklist_templates", "m67"),
  proof: proof(`${trgdef} LIKE '%UPDATE OF archived_at%'`, `'trigger on archived_at only'`),
});
add("m68-audit-archiver-recomputed.sql", {
  what: "BACKLOG-3474 PR 3: archived_by recomputed on every update while archived (no transition guard)",
  targets: "c38",
  sql: edit(audit, "  ELSIF OLD.archived_at IS NULL THEN\n", "  ELSIF NEW.archived_at IS NOT NULL THEN\n", "m68"),
  proof: proof(`${def(AUDIT)} LIKE '%ELSIF NEW.archived_at IS NOT NULL%'`, `'no transition guard'`),
});
add("m70-audit-archiver-written-back.sql", {
  what: "BACKLOG-3474 PR 3 (SR B1): archived_by written back from OLD while archived, undoing the FK's ON DELETE SET NULL",
  targets: "c40",
  sql: edit(audit, "  ELSIF OLD.archived_at IS NULL THEN\n    NEW.archived_by := auth.uid();\n  END IF;\n",
    "  ELSIF OLD.archived_at IS NULL THEN\n    NEW.archived_by := auth.uid();\n  ELSE\n    NEW.archived_by := OLD.archived_by;\n  END IF;\n", "m70"),
  proof: proof(`${def(AUDIT)} LIKE '%NEW.archived_by := OLD.archived_by%'`, `'archived_by written back from OLD'`),
});
add("m69-audit-columns-granted.sql", {
  what: "BACKLOG-3474 PR 3: UPDATE and INSERT granted on updated_by and archived_by",
  targets: "c39",
  sql: "GRANT UPDATE (updated_by, archived_by), INSERT (updated_by, archived_by) ON public.checklist_templates TO authenticated;",
  proof: proof(`has_column_privilege('authenticated', 'public.checklist_templates', 'updated_by', 'UPDATE')`, `'updated_by updatable'`),
});

const fileMutants = {
  "f01-retire-without-guard.sql": {
    what: "migration 3 without its guard block",
    replaces: 3,
    targets: "c20",
    text: edit(M3, M3.slice(M3.indexOf("DO $guard$"), M3.indexOf("$guard$;\n", M3.indexOf("DO $guard$") + 10) + "$guard$;\n".length), "", "f01"),
  },
  "a01-schema-bare-create-policy.sql": {
    what: "migration 2 creates one policy without DROP POLICY IF EXISTS first (second apply: 42710)",
    replaces: 2,
    text: edit(M2, "DROP POLICY IF EXISTS checklist_templates_select_member ON public.checklist_templates;\n", "", "a01"),
  },
  "a02-plan-features-do-update.sql": {
    what: "migration 2's plan rows use ON CONFLICT DO UPDATE (a second apply reverts an admin's toggle)",
    replaces: 2,
    text: edit(
      M2,
      "ON CONFLICT (plan_id, feature_id) DO NOTHING;",
      "ON CONFLICT (plan_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled, value = EXCLUDED.value;",
      "a02",
    ),
  },
  "a03-table-without-if-not-exists.sql": {
    what: "migration 2 creates checklist_templates without IF NOT EXISTS (second apply: 42P07)",
    replaces: 2,
    text: edit(M2, "CREATE TABLE IF NOT EXISTS public.checklist_templates (", "CREATE TABLE public.checklist_templates (", "a03"),
  },
  "a04-trigger-without-or-replace.sql": {
    what: "migration 1 creates its trigger without OR REPLACE (second apply: 42710)",
    replaces: 1,
    text: edit(M1, "CREATE OR REPLACE TRIGGER reject_feature_override_above_tier", "CREATE TRIGGER reject_feature_override_above_tier", "a04"),
  },
  "a05-drop-column-without-if-exists.sql": {
    what: "migration 3 drops a column without IF EXISTS (second apply: 42703)",
    replaces: 3,
    text: edit(M3, "DROP COLUMN IF EXISTS require_dual_approval", "DROP COLUMN require_dual_approval", "a05"),
  },
};

function render() {
  const out = {};
  for (const [file, m] of Object.entries(mutants)) {
    const lines = [
      "-- BACKLOG-3473 MUTANT (generated by generate.mjs from the shipped files; do not hand-edit)",
      `-- ${m.what}`,
      `-- targets: ${m.targets}`,
    ];
    if (m.expect) lines.push(`-- expect: ${m.expect}`);
    lines.push("-- Runs INSIDE a control's transaction, after the prelude; rolled back with it.", "");
    out[file] = `${lines.join("\n")}\n${m.sql}\n${m.proof}`;
  }
  for (const [file, m] of Object.entries(fileMutants)) {
    const lines = [
      "-- BACKLOG-3473 MUTANT (generated by generate.mjs from the shipped files; do not hand-edit)",
      `-- ${m.what}`,
      `-- replaces-file: ${m.replaces}`,
    ];
    if (m.targets) lines.push(`-- targets: ${m.targets}`);
    out[file] = `${lines.join("\n")}\n${m.text}`;
  }
  return out;
}

const mode = process.argv[2] ?? "";
if (mode === "--self-test") {
  let threw = 0;
  for (const [from, label] of [
    ["a pattern that is not in the migration", "absent"],
    ["\n", "duplicate"],
  ]) {
    try {
      edit(M2, from, "x", `self-test ${label}`);
      console.error(`self-test: edit() did NOT throw for the ${label} pattern`);
    } catch (e) {
      threw++;
      console.log(`self-test: edit() threw for the ${label} pattern: ${e.message.split("\n")[0]}`);
    }
  }
  process.exit(threw === 2 ? 0 : 1);
}

const rendered = render();
if (mode === "--check") {
  const onDisk = readdirSync(HERE).filter((f) => f.endsWith(".sql"));
  const stale = onDisk.filter((f) => !(f in rendered) || readFileSync(join(HERE, f), "utf8") !== rendered[f]);
  const missing = Object.keys(rendered).filter((f) => !onDisk.includes(f));
  if (stale.length || missing.length) {
    console.error(`generate.mjs --check: stale ${stale.join(", ") || "none"}; missing ${missing.join(", ") || "none"}`);
    process.exit(1);
  }
  console.log(`generate.mjs --check: ${onDisk.length} mutant files match the shipped migrations`);
  process.exit(0);
}
for (const [file, body] of Object.entries(rendered)) writeFileSync(join(HERE, file), body);
console.log(
  `generate.mjs: wrote ${Object.keys(rendered).length} mutant files (${Object.keys(mutants).length} SQL, ${Object.keys(fileMutants).length} whole-file)`,
);
