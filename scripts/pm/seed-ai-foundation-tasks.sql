-- =====================================================================
-- AI Assistant Foundation — consolidated PM seed
--
-- Run this ONCE against the Keepr Supabase project (nercleijfrxqcvfjskbc).
-- Fully idempotent: every block guards itself and no-ops if already applied,
-- so re-running is safe.
--
-- What it does:
--   1. Records the six founder decisions on BACKLOG-2266 and marks it approved
--   2. Creates the [P2] tiered consent & T&C versioning epic
--   3. Breaks the first three epics into executable pm_tasks
--
-- NOTE: an earlier version of this file created a scope-named sprint.
-- That was wrong: in Keepr, a sprint is a two-week TIME BOX (e.g.
-- "SPRINT-168: July 13-27, 2026"), not a scope container. Tasks are
-- assigned to whichever two-week window they are worked in. The sprint
-- creation has been removed and tasks are left with sprint_id NULL.
--
-- Written for local execution (psql / Supabase SQL editor) because the MCP
-- connector rejects writes from the remote session.
-- =====================================================================

-- ---------------------------------------------------------------------
-- BLOCK 1 — founder decisions on BACKLOG-2266 + approval
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM pm_backlog_items
  WHERE legacy_id = 'BACKLOG-2266' AND deleted_at IS NULL;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-2266 not found — aborting';
  END IF;

  IF EXISTS (SELECT 1 FROM pm_backlog_items WHERE id = v_id AND body LIKE '%Founder decisions (recorded 2026-07-27)%') THEN
    RAISE NOTICE 'BLOCK 1: decisions already recorded — skipped.';
  ELSE
    UPDATE pm_backlog_items SET body = body || E'\n\n## Founder decisions (recorded 2026-07-27)\n\nSigned-off doc: `.claude/docs/proposals/ai-tier-foundation-decisions.md`\n\n**1. Privacy envelope = the tier ladder** (privacy level, inference location, and price are one axis):\n- **Base (compliance):** strict local — nothing leaves the device, no AI. Ledger + corrections still accumulate locally.\n- **AI tier:** local inference by default; cloud PROCESSING-ONLY with explicit consent (no server-side storage). Managed/metered LLM default, BYO-key an option.\n- **Premium:** fully consented encrypted cloud corpus — any-device access, cross-device unification, background assistant.\n- Terms: existing re-consent flow covers the mechanics; T&C update at AI-tier launch. Residual action is wording-only — keep outward copy free of absolutes ("nothing ever leaves your machine"), use "local by default, encrypted, AI features only with your explicit consent".\n\n**2. LLM economics:** hybrid ladder — deterministic patterns -> light LOCAL model -> managed cloud (metered) for hard tasks. BYO-key is an option, not the default. Local-model packaging is its own epic and must NOT block contact matching (which needs no model). Add "local" as a third provider behind the existing llm/ abstraction now.\n\n**3. Timeline:** base users onboard soon (additive-only schema from that point; ledger ships in their first build). AI-tier testing at 1-3 months, scoped to matching + evidence-backed detection + ledger accumulation. Out of scope: corpus, graph, outbound actions, assistant.\n\n**4. First buyer: individual agents** (TC-replacement wedge, $300-500/closing anchor). Brokerage compliance-intelligence wedge deferred.\n\n**5. Autonomy ceiling:** draft-for-approval at launch and for the foreseeable future. Auto-send is a possible future per-action-type graduation; architecture keeps the door open, product commits to nothing.\n\n**6. Hardware:** runtime capability check picks the inference rung PER DEVICE. Capable -> local model. Not capable -> informed and REROUTED (not walled) to consented cloud or BYO-key. Check runs PRE-purchase. Model choice + thresholds ship as a REMOTE-UPDATABLE manifest so the local floor drops via config push as lighter models arrive.', updated_at = now()
    WHERE id = v_id;

    INSERT INTO pm_events (item_id, event_type, new_value, metadata)
    VALUES (v_id, 'updated', 'body', jsonb_build_object('source', 'ai-foundation-seed', 'change', 'recorded six founder decisions'));

    RAISE NOTICE 'BLOCK 1: decisions recorded.';
  END IF;

  IF (SELECT status FROM pm_backlog_items WHERE id = v_id) <> 'completed' THEN
    UPDATE pm_backlog_items SET status = 'completed', updated_at = now() WHERE id = v_id;
    INSERT INTO pm_events (item_id, event_type, old_value, new_value, metadata)
    VALUES (v_id, 'status_changed', 'pending', 'completed', jsonb_build_object('source', 'ai-foundation-seed', 'note', 'founder signed off on decision doc 2026-07-27'));
    RAISE NOTICE 'BLOCK 1: BACKLOG-2266 marked completed.';
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- BLOCK 2 — [P2] tiered consent & T&C versioning epic
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_project_id UUID;
  v_base INT;
  v_item UUID;
BEGIN
  SELECT id INTO v_project_id FROM pm_projects
  WHERE name = 'AI Assistant Foundation' AND deleted_at IS NULL;
  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'Project "AI Assistant Foundation" not found — aborting';
  END IF;

  IF EXISTS (SELECT 1 FROM pm_backlog_items WHERE project_id = v_project_id AND deleted_at IS NULL AND title LIKE '%Tiered consent%') THEN
    RAISE NOTICE 'BLOCK 2: consent epic already exists — skipped.';
    RETURN;
  END IF;

  SELECT COALESCE(MAX(item_number), 0) INTO v_base FROM pm_backlog_items;

  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 1), v_base + 1,
    '[P2] Tiered consent & T&C versioning (consent ledger)',
    'Per-tier T&C variants + separate revocable AI-processing consent, with append-only acceptance history. Needed before external AI-tier testing.',
    E'## Goal\nExtend the existing T&C acceptance system to support the tier ladder: per-tier document requirements, a legally separate (and revocable) AI-processing consent, and audit-grade acceptance history.\n\n## What exists today\n`users.terms_version_accepted` / `privacy_policy_version_accepted` (+ `*_accepted_at`) — single current-version slots checked at auth (see `supabase_schema.sql` lines 41-44 and `supabase_migration_add_version_columns.sql`).\n\nGaps: overwrite-in-place (no acceptance history), no tier dimension, no separate AI consent, no revocation model.\n\n## Design — one rule covers all three scenarios\n```\nrequired_docs(tier, current_versions) - accepted_docs(user) = delta -> prompt for the delta\n```\nRuns at: **signup** (new user gets the correct doc set for their tier), **login** (returning user prompted on new versions), **tier change** (upgrade prompts only the ADDITIONAL grants — AI tier adds processing consent, premium adds cloud-storage consent).\n\n## Scope\n- Doc registry table: `doc_type`, `version`, `applies_to_tiers`, `effective_at`.\n- Append-only `consent_acceptances`: user, doc_type, version, tier, accepted_at, app_version, revoked_at. Keep existing `users.*` columns as a "latest accepted" cache for back-compat.\n- Revocation: withdrawing AI-processing consent immediately stops cloud calls (hard gate, not advisory).\n- Gating: consent state rides the same check as entitlements — feature available = entitlement AND active consent.\n\n## Acceptance criteria\n- Delta rule unit-tested across all 3 scenarios + revocation.\n- Cloud LLM call paths hard-gated on active consent, verified by test (not by inspection).\n\n## Founder testing gate\nFlip a test account across tiers and confirm exactly the right prompts appear (and nothing extra); revoke AI consent and observe cloud processing stop while local features keep working.',
    'epic', 'high', 'pending', v_project_id, 150000, 9
  ) RETURNING id INTO v_item;

  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'ai-foundation-seed', 'note', 'founder-identified requirement'));

  RAISE NOTICE 'BLOCK 2: created consent epic BACKLOG-%', v_base + 1;
END $$;


-- ---------------------------------------------------------------------
-- BLOCK 3 — executable task breakdown (no sprint; see note above)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_project_id UUID;
  v_sprint UUID;
  v_char UUID;     -- BACKLOG-2267 characterization tests
  v_spike UUID;    -- BACKLOG-2273 matching feasibility spike
  v_ledger UUID;   -- BACKLOG-2268 observation ledger
  v_n INT;
BEGIN
  SELECT id INTO v_project_id FROM pm_projects
  WHERE name = 'AI Assistant Foundation' AND deleted_at IS NULL;

  IF EXISTS (SELECT 1 FROM pm_sprints WHERE name = 'AI Foundation 1 — Spike & Safety Net') THEN
    RAISE NOTICE 'BLOCK 3: sprint already exists — skipped.';
    RETURN;
  END IF;

  INSERT INTO pm_sprints (legacy_id, name, goal, body, status, project_id)
  VALUES (
    'SPRINT-AI-01',
    'AI Foundation 1 — Spike & Safety Net',
    'Prove contact matching is feasible on real data, and build the characterization safety net before any write-path changes.',
    E'## Why these two together\nThe matching spike is the load-bearing feasibility bet of the whole AI plan — if auto-matching cannot hit usable precision on real data, the roadmap changes shape. It is read-only, so it runs in parallel with the characterization tests that must exist before anyone touches identity write paths.\n\n## Integration branch\nCreate `int/ai-foundation` from `develop` at sprint start. All task PRs target it. One PR from `int/ai-foundation` -> `develop` at sprint end.\n\n## Exit criteria\n- Measured precision/recall on the founder''s real database, with recommended thresholds.\n- Characterization tests green and pinning current identity/resolution behavior.\n- Founder gate passed on both.',
    'planned', v_project_id
  ) RETURNING id INTO v_sprint;

  SELECT id INTO v_char   FROM pm_backlog_items WHERE legacy_id = 'BACKLOG-2267' AND deleted_at IS NULL;
  SELECT id INTO v_spike  FROM pm_backlog_items WHERE legacy_id = 'BACKLOG-2273' AND deleted_at IS NULL;
  SELECT id INTO v_ledger FROM pm_backlog_items WHERE legacy_id = 'BACKLOG-2268' AND deleted_at IS NULL;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(legacy_id, '\D', '', 'g'), '')::INT), 0)
    INTO v_n FROM pm_tasks WHERE legacy_id LIKE 'TASK-%';

  -- ===== BACKLOG-2273 — matching feasibility spike (read-only) =====
  INSERT INTO pm_tasks (legacy_id, title, description, body, status, backlog_item_id, sprint_id, est_tokens, sort_order) VALUES
  ('TASK-' || (v_n+1),
   'Spike: read-only contact-match scoring harness',
   'Build a read-only script that scores candidate identity pairs and reports match/possible/non-match zones. No writes, no schema changes.',
   E'## Context\nThis is a MEASUREMENT task, not a feature. Nothing it produces ships to users.\n\nMatching logic already exists — `electron/services/contactResolutionService.ts` and `electron/services/messageMatchingService.ts`. **Read these first.** The harness measures how well current logic performs and how much a scored approach would improve it; it does not start greenfield.\n\n## Real join paths (verified against `electron/database/schema.sql`)\n- `contacts` (id, user_id, display_name, company, source) — has NO email/phone columns\n- `contact_emails` (contact_id, email, is_primary, label, source)\n- `contact_phones` (contact_id, phone_e164, phone_normalized, is_primary, label, source)\n- `external_contacts` (name, emails_json, phones_json, phones_normalized_json, company, source) — synced address book\n- `email_participants` (email_id, role, position, email_address, display_name, resolved_contact_id) — `resolved_contact_id` is the existing resolution output and a ground-truth signal\n\n## Approach\n1. **Blocking** — never score all N^2 pairs. Block on: shared normalized phone (`phone_normalized`, last-10-digits), shared email local-part, name trigram, shared email thread.\n2. **Score each candidate pair** on independent features: exact email match, exact phone match, name similarity (Jaro-Winkler), company match, thread co-occurrence, temporal overlap.\n3. **Three zones** (Fellegi-Sunter): auto-match / suggest-to-user / non-match. Output the threshold curve, not just one number.\n4. **Output**: aggregate stats ONLY — counts, precision, recall, zone distribution at varying thresholds. **No names, no addresses, no raw identifiers in output** — the founder runs this on real personal data and pastes results back.\n\n## Deliverable\n`scripts/spikes/contact-match-harness.ts`, runnable via `npx tsx` against a local Keepr SQLite DB path passed as an argument. Read-only connection. Prints a summary table.\n\n## Acceptance criteria\n- Runs against the founder''s real DB without writing anything (open the DB read-only and assert it).\n- Output contains zero PII — verify by inspection of the output, not just intent.\n- Reports precision/recall against `email_participants.resolved_contact_id` as the labelled baseline.\n- Blocking reduces the candidate set by >95% vs full cross-product; report the actual figure.',
   'pending', v_spike, v_sprint, 120000, 1),

  ('TASK-' || (v_n+2),
   'Spike: run harness on real data, report feasibility',
   'Founder runs the harness locally on their real database; engineer analyses the output and writes the feasibility verdict.',
   E'## Context\nDepends on TASK-' || (v_n+1) || E'. The founder runs this locally — their contact and email history never leaves their machine; only aggregate statistics come back.\n\n## Steps\n1. Give the founder a single copy-paste command.\n2. Founder returns the summary output (aggregates only).\n3. Analyse: at what threshold does precision exceed 95%? What recall does that buy? How large is the "suggest" zone the user would have to review?\n\n## Deliverable\nA short verdict appended to BACKLOG-2273''s body:\n- **Feasible** — recommended auto/suggest/reject thresholds and expected review burden, or\n- **Not feasible as designed** — which signals were too weak, and what would have to change.\n\n## Acceptance criteria\n- Verdict is stated in measured numbers, never in adjectives.\n- If infeasible, that is a VALID and valuable outcome — say so plainly rather than forcing an optimistic read. The point of a spike is to find out.\n\n## Founder testing gate\nFounder confirms the numbers match what they would expect from their own knowledge of their contacts — e.g. known duplicates are actually caught.',
   'pending', v_spike, v_sprint, 60000, 2),

  -- ===== BACKLOG-2267 — characterization tests (safety net) =====
  ('TASK-' || (v_n+3),
   'Characterize contact identity write paths',
   'Pin current behavior of contact create/merge/dedupe with tests, before any identity refactor touches it.',
   E'## Why\nCharacterization tests describe what the code CURRENTLY does — including bugs — so that later refactors surface unintended changes. They are not correctness tests; do not "fix" behavior you find odd, pin it and note it.\n\n## Cover\n- `electron/services/db/contactDbService.ts` — create, update, dedupe on `contact_emails`/`contact_phones` UNIQUE constraints\n- `electron/services/db/externalContactDbService.ts` — address-book sync upsert keyed on `(user_id, source, external_record_id)`\n- `electron/services/contactResolutionService.ts` — how `email_participants.resolved_contact_id` gets assigned\n- Phone normalization: `phone_e164` vs `phone_normalized` (last-10-digit lookup key, BACKLOG-1727)\n\n## Acceptance criteria\n- Tests pass against current `develop` with zero production-code changes.\n- Each surprising behavior found is documented in the PR body (do not fix it in this task).\n- Coverage of the touched services measurably increases; state the before/after figure.',
   'pending', v_char, v_sprint, 90000, 3),

  ('TASK-' || (v_n+4),
   'Characterize transaction detection & contact linking',
   'Pin current auto-detection and transaction_contacts linking behavior before intelligence work alters it.',
   E'## Cover\n- `electron/services/transactionExtractorService.ts` — what triggers detection, what confidence is assigned\n- `electron/services/db/transactionContactDbService.ts` — role assignment into `transaction_contacts` (role, role_category, specific_role)\n- `transactions.detection_source` / `detection_status` / `detection_confidence` transitions\n- `transactions.suggested_contacts` JSON shape — pin the actual structure, as later evidence work depends on it\n\n## Acceptance criteria\n- Tests pass against current `develop` with zero production-code changes.\n- The `suggested_contacts` JSON contract is documented in the PR body.\n- Any place where detection silently swallows an error is noted (documented, not fixed).',
   'pending', v_char, v_sprint, 90000, 4),

  -- ===== BACKLOG-2268 — observation ledger (must ship before onboarding) =====
  ('TASK-' || (v_n+5),
   'Observation ledger — additive schema migration',
   'Add the append-only observation ledger tables. Additive only; no changes to existing tables.',
   E'## Why now\nDecision 3: the ledger must ship in the FIRST build onboarding users install, so history capture starts on day one. This is the one piece of foundation with a hard deadline.\n\n## Scope\nNew append-only table(s) recording observations: what was seen, from which source, when, with what confidence, and which process produced it. Shape follows W3C PROV concepts (entity / activity / agent) without importing the ontology.\n\n## Constraints\n- **Additive only.** No ALTER on existing tables beyond adding nullable columns.\n- Follow the existing migration pattern in `electron/services/databaseService.ts` (see the v40-v51 migration tests for the established shape).\n- Add a matching migration test alongside the existing `databaseService.migration-v*.test.ts` files.\n- SOC 2 audit-logging posture extends to the new tables.\n\n## Acceptance criteria\n- Migration runs forward cleanly on a populated database.\n- Schema-parity test (`databaseService.schema-parity.test.ts`) still passes.\n- No existing test changes behavior.\n\n## Founder testing gate\nInstall a build with the migration over an existing populated database; confirm no data loss and the app starts normally.',
   'pending', v_ledger, v_sprint, 110000, 5);

  RAISE NOTICE 'BLOCK 3: created sprint + 5 tasks (TASK-% .. TASK-%).', v_n+1, v_n+5;
END $$;


-- ---------------------------------------------------------------------
-- Verification — run after the blocks above
-- ---------------------------------------------------------------------
SELECT b.legacy_id, b.title, b.status,
       (SELECT count(*) FROM pm_tasks t WHERE t.backlog_item_id = b.id AND t.deleted_at IS NULL) AS tasks
FROM pm_backlog_items b
WHERE b.project_id = (SELECT id FROM pm_projects WHERE name = 'AI Assistant Foundation' AND deleted_at IS NULL)
  AND b.deleted_at IS NULL
ORDER BY b.sort_order;
