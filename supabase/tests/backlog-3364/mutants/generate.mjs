#!/usr/bin/env node
// BACKLOG-3364: derive the mutant files from the SHIPPED migration and backfill.
//
//   node supabase/tests/backlog-3364/mutants/generate.mjs
//
// Each mutant is one targeted edit of shipped text. Every edit is an exact
// string replacement that THROWS when its pattern is absent, so a mutant can
// never be written unchanged. Each SQL mutant also ends with an in-database
// proof block that raises unless the mutation is visible in the catalog, then
// prints `MUTATION APPLIED: ...`; run.sh refuses to count a result without it.
//
// Re-run after any change to the migration or the backfill, then re-run the
// mutant matrix (run.sh mutants) before recording results.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const MIGRATION = readFileSync(
  join(REPO, "supabase/migrations/20260915160637_backlog_3364_personal_organizations.sql"),
  "utf8",
);
const BACKFILL = readFileSync(join(REPO, "supabase/parked/backlog-3364/backfill_personal_organizations.sql"), "utf8");

/** Exact replacement; throws if `from` does not occur exactly once. */
function edit(text, from, to, label) {
  const first = text.indexOf(from);
  if (first === -1) throw new Error(`${label}: pattern not found:\n${from}`);
  if (text.indexOf(from, first + from.length) !== -1) throw new Error(`${label}: pattern occurs more than once`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

/** The shipped CREATE OR REPLACE FUNCTION block for `name`, through its closing `$$;`. */
function fn(name) {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in migration`);
  const end = MIGRATION.indexOf("\n$$;", start);
  if (end === -1) throw new Error(`function ${name}: no closing $$;`);
  return MIGRATION.slice(start, end + "\n$$;".length);
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

const defOf = (sig) => `pg_get_functiondef('${sig}'::regprocedure)`;
const ENSURE = "public._ensure_personal_organization_for(uuid)";
const RETIRE = "public._retire_personal_membership()";

const PROD_S2 = `DROP POLICY IF EXISTS "agents_can_create_submissions" ON public.transaction_submissions;
CREATE POLICY "agents_can_create_submissions" ON public.transaction_submissions
  FOR INSERT TO public
  WITH CHECK ((submitted_by = ( SELECT auth.uid() AS uid)) AND (organization_id IN ( SELECT organization_members.organization_id
     FROM public.organization_members
    WHERE (organization_members.user_id = ( SELECT auth.uid() AS uid)))));`;

const PROD_S3 = `DROP POLICY IF EXISTS "Members can upload submission attachments" ON storage.objects;
CREATE POLICY "Members can upload submission attachments" ON storage.objects
  FOR INSERT TO public
  WITH CHECK ((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (organization_members.organization_id)::text AS organization_id
     FROM public.organization_members
    WHERE (organization_members.user_id = auth.uid()))));`;

const ensure = fn("_ensure_personal_organization_for");
const retire = fn("_retire_personal_membership");

const mutants = {
  "m01-s2-submission-rule-without-personal-clause.sql": {
    what: "transaction_submissions INSERT policy restored to production's text (no personal clause)",
    sql: PROD_S2,
    proof: proof(
      `NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transaction_submissions' AND policyname='agents_can_create_submissions' AND with_check LIKE '%personal_owner_user_id%')`,
      `(SELECT with_check FROM pg_policies WHERE schemaname='public' AND tablename='transaction_submissions' AND policyname='agents_can_create_submissions')`,
    ),
  },
  "m02-s3-upload-rule-without-personal-clause.sql": {
    what: "storage.objects upload policy restored to production's text (no personal clause)",
    sql: PROD_S3,
    proof: proof(
      `NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='Members can upload submission attachments' AND with_check LIKE '%personal_owner_user_id%')`,
      `(SELECT with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='Members can upload submission attachments')`,
    ),
  },
  "m03-column-guard-removed.sql": {
    what: "the column guard trigger on organizations dropped",
    sql: "DROP TRIGGER guard_personal_owner_user_id ON public.organizations;",
    proof: proof(
      `NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.organizations'::regclass AND tgname='guard_personal_owner_user_id')`,
      `'guard trigger absent'`,
    ),
  },
  "m04-retirement-trigger-removed.sql": {
    what: "the retirement trigger on organization_members dropped",
    sql: "DROP TRIGGER retire_personal_membership ON public.organization_members;",
    proof: proof(
      `NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND tgname='retire_personal_membership')`,
      `'retirement trigger absent'`,
    ),
  },
  "m05-retirement-on-insert-only.sql": {
    what: "the retirement trigger fires on INSERT only (a claim by UPDATE is missed)",
    sql: `CREATE OR REPLACE TRIGGER retire_personal_membership
  AFTER INSERT ON public.organization_members
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION public._retire_personal_membership();`,
    proof: proof(
      `(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND tgname='retire_personal_membership') NOT LIKE '%UPDATE%'`,
      `(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND tgname='retire_personal_membership')`,
    ),
  },
  "m06-retirement-deletes-personal-org.sql": {
    what: "the retirement function deletes the personal ORGANIZATION instead of the membership",
    sql: edit(
      retire,
      `  DELETE FROM public.organization_members m
   USING public.organizations o
   WHERE m.organization_id = o.id
     AND o.personal_owner_user_id IS NOT NULL
     AND m.user_id = NEW.user_id;`,
      `  DELETE FROM public.organizations
   WHERE personal_owner_user_id = NEW.user_id;`,
      "m06",
    ),
    proof: proof(
      `${defOf(RETIRE)} LIKE '%DELETE FROM public.organizations%'`,
      `'retirement deletes organizations'`,
    ),
  },
  "m07-retirement-deletes-every-other-membership.sql": {
    what: "the retirement function deletes EVERY other membership of the user, brokerage rows included",
    sql: edit(
      retire,
      `     AND o.personal_owner_user_id IS NOT NULL
     AND m.user_id = NEW.user_id;`,
      `     AND m.organization_id <> NEW.organization_id
     AND m.user_id = NEW.user_id;`,
      "m07",
    ),
    proof: proof(`${defOf(RETIRE)} LIKE '%<> NEW.organization_id%'`, `'retirement deletes all other memberships'`),
  },
  "m20-retirement-deletes-without-user-filter.sql": {
    what: "the retirement function's DELETE has no user filter (every user's personal membership is removed)",
    sql: edit(
      retire,
      `     AND o.personal_owner_user_id IS NOT NULL
     AND m.user_id = NEW.user_id;`,
      `     AND o.personal_owner_user_id IS NOT NULL;`,
      "m20",
    ),
    proof: proof(
      `${defOf(RETIRE)} NOT LIKE '%m.user_id = NEW.user_id%'`,
      `regexp_replace(substring(${defOf(RETIRE)} from 'DELETE FROM[^;]*;'), '\\s+', ' ', 'g')`,
    ),
  },
  "m08-trigger-added-on-auth-users.sql": {
    what: "a sign-up trigger on auth.users that calls ensure",
    sql: `CREATE FUNCTION public._t3364_mutant_signup_ensure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $m$
BEGIN
  PERFORM public._ensure_personal_organization_for(NEW.id);
  RETURN NEW;
END
$m$;
CREATE TRIGGER t3364_mutant_signup_ensure AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public._t3364_mutant_signup_ensure();`,
    proof: proof(
      `EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND tgname='t3364_mutant_signup_ensure')`,
      `'trigger t3364_mutant_signup_ensure on auth.users'`,
    ),
  },
  "m09-ensure-short-circuits-on-active-only.sql": {
    what: "ensure short-circuits only on ACTIVE brokerage memberships",
    sql: edit(
      ensure,
      `    WHERE m.user_id = p_user_id
      AND o.personal_owner_user_id IS NULL
  ) THEN`,
      `    WHERE m.user_id = p_user_id
      AND o.personal_owner_user_id IS NULL
      AND m.license_status = 'active'
  ) THEN`,
      "m09",
    ),
    proof: proof(`${defOf(ENSURE)} LIKE '%m.license_status = ''active''%'`, `'short-circuit filtered to active'`),
  },
  "m10-ensure-any-invite-blocks.sql": {
    what: "ensure treats an EXPIRED invite as blocking (expiry test removed)",
    sql: edit(ensure, `      AND (invitation_expires_at IS NULL OR invitation_expires_at >= NOW())\n`, "", "m10"),
    proof: proof(`${defOf(ENSURE)} NOT LIKE '%invitation_expires_at%'`, `'expiry test removed'`),
  },
  "m11-ensure-invite-match-exact.sql": {
    what: "ensure matches the invite email exactly (no lower/trim)",
    sql: edit(
      ensure,
      "AND LOWER(TRIM(invited_email)) = LOWER(TRIM(v_email))",
      "AND invited_email = v_email",
      "m11",
    ),
    proof: proof(`${defOf(ENSURE)} LIKE '%AND invited_email = v_email%'`, `'exact email match'`),
  },
  "m12-ensure-membership-insert-without-on-conflict.sql": {
    what: "ensure's membership INSERT has no ON CONFLICT",
    sql: edit(
      ensure,
      `    (v_org_id, p_user_id, 'agent', 'active', NOW(), NULL)
  ON CONFLICT (organization_id, user_id) DO NOTHING;`,
      `    (v_org_id, p_user_id, 'agent', 'active', NOW(), NULL);`,
      "m12",
    ),
    proof: proof(`${defOf(ENSURE)} NOT LIKE '%ON CONFLICT (organization_id, user_id)%'`, `'membership ON CONFLICT removed'`),
  },
  "m13-ensure-leaves-jit-at-default.sql": {
    what: "ensure does not set jit_provisioning_enabled (column default true)",
    sql: edit(
      edit(
        ensure,
        "(name, slug, max_seats, jit_provisioning_enabled, default_member_role, personal_owner_user_id)",
        "(name, slug, max_seats, default_member_role, personal_owner_user_id)",
        "m13a",
      ),
      "1, false, 'agent', p_user_id)",
      "1, 'agent', p_user_id)",
      "m13b",
    ),
    proof: proof(`${defOf(ENSURE)} NOT LIKE '%jit_provisioning_enabled%'`, `'jit column not set'`),
  },
  "m14-ensure-member-role-admin.sql": {
    what: "ensure writes the owner's membership with role admin",
    sql: edit(
      ensure,
      "(v_org_id, p_user_id, 'agent', 'active', NOW(), NULL)",
      "(v_org_id, p_user_id, 'admin', 'active', NOW(), NULL)",
      "m14",
    ),
    proof: proof(`${defOf(ENSURE)} LIKE '%p_user_id, ''admin'', ''active''%'`, `'membership role admin'`),
  },
  "m15-ensure-no-license-check.sql": {
    what: "ensure does not require a license",
    sql: edit(
      ensure,
      `  IF NOT EXISTS (SELECT 1 FROM public.licenses WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'no_license');
  END IF;
`,
      "",
      "m15",
    ),
    proof: proof(`${defOf(ENSURE)} NOT LIKE '%no_license%'`, `'license check removed'`),
  },
  "m16-ensure-recreates-member-less-org.sql": {
    what: "ensure deletes a member-less personal organization and creates a new one",
    sql: edit(
      ensure,
      `  INSERT INTO public.organizations
    (name, slug,`,
      `  DELETE FROM public.organizations o
   WHERE o.personal_owner_user_id = p_user_id
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = o.id);

  INSERT INTO public.organizations
    (name, slug,`,
      "m16",
    ),
    proof: proof(`${defOf(ENSURE)} LIKE '%DELETE FROM public.organizations o%'`, `'recreate branch present'`),
  },
  "m17-ensure-attaches-to-occupied-org.sql": {
    what: "ensure attaches to its organization even when another membership row exists there",
    sql: edit(
      ensure,
      `  -- Attach only to an organization that holds no other membership row.
  IF EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = v_org_id
      AND user_id IS DISTINCT FROM p_user_id
  ) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
`,
      "",
      "m17",
    ),
    proof: proof(`${defOf(ENSURE)} NOT LIKE '%''conflict''%'`, `'occupied-org check removed'`),
  },
  "m18-internal-function-granted-to-authenticated.sql": {
    what: "EXECUTE on the internal function granted to authenticated",
    sql: `GRANT EXECUTE ON FUNCTION ${ENSURE} TO authenticated;`,
    proof: proof(
      `has_function_privilege('authenticated', '${ENSURE}', 'EXECUTE')`,
      `'authenticated holds EXECUTE on the internal function'`,
    ),
  },
  "m19-wrapper-takes-a-user-id.sql": {
    what: "the wrapper takes a user id argument",
    sql: `DROP FUNCTION public.ensure_personal_organization();
CREATE FUNCTION public.ensure_personal_organization(p_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $m$
BEGIN
  RETURN public._ensure_personal_organization_for(coalesce(p_user_id, auth.uid()));
END
$m$;
GRANT EXECUTE ON FUNCTION public.ensure_personal_organization(uuid) TO authenticated;`,
    proof: proof(
      `(SELECT pronargs FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ensure_personal_organization') = 1`,
      `'wrapper has 1 argument'`,
    ),
  },
};

let written = 0;
for (const [file, m] of Object.entries(mutants)) {
  const body = `-- BACKLOG-3364 MUTANT (generated by generate.mjs from the shipped files; do not hand-edit)
-- ${m.what}
-- Runs INSIDE a control's transaction, after lib/fixtures.sql; rolled back with it.

${m.sql}
${m.proof}`;
  writeFileSync(join(HERE, file), body);
  written++;
}

// File mutant for the backfill (substituted via -v backfill=...).
const b01 = edit(
  BACKFILL,
  `    IF r.email IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.organization_members
      WHERE user_id IS NULL
        AND LOWER(TRIM(invited_email)) = LOWER(TRIM(r.email))
    ) THEN
      n_skip_invite := n_skip_invite + 1;
      CONTINUE;
    END IF;
`,
  "",
  "b01",
);
writeFileSync(
  join(HERE, "b01-backfill-without-invite-skip.sql"),
  `-- BACKLOG-3364 MUTANT (generated by generate.mjs; do not hand-edit): backfill without the unclaimed-invite skip\n${b01}`,
);
written++;

// Transaction-shape mutants for the whole migration (run by run.sh txn / twice).
const withFailure = edit(MIGRATION, "\nCOMMIT;\n", "\nSELECT 1/0 AS injected_failure;\nCOMMIT;\n", "t1");
writeFileSync(join(HERE, "t1-migration-with-failing-last-statement.sql"), withFailure);
const autocommit =
  edit(edit(MIGRATION, "\nBEGIN;\n", "\n", "t1m-begin"), "\nCOMMIT;\n", "\n", "t1m-commit") +
  "\nSELECT 1/0 AS injected_failure;\n";
writeFileSync(join(HERE, "t1m-migration-autocommit-with-failing-last-statement.sql"), autocommit);
const noIfNotExists = edit(MIGRATION, "ADD COLUMN IF NOT EXISTS", "ADD COLUMN", "t2m");
writeFileSync(join(HERE, "t2m-migration-add-column-without-if-not-exists.sql"), noIfNotExists);
written += 3;

console.log(`generate.mjs: wrote ${written} mutant files`);
