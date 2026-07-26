-- ============================================
-- PM Seed: "AI Assistant Foundation" planned project + Phase 0/1 epics
--
-- Creates one pm_projects row (status='planned') and 7 epics in
-- pm_backlog_items, per the MCP-session convention in CLAUDE.md:
-- direct SQL on pm_* tables, item_number = MAX+1 set manually,
-- legacy_id = 'BACKLOG-<n>', pm_events rows for audit.
--
-- Idempotent: aborts if a live project with this name already exists.
-- Run via Supabase SQL editor, psql, or an MCP session with SQL approval.
-- ============================================

DO $$
DECLARE
  v_project_id UUID;
  v_base INT;
  v_item UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM pm_projects WHERE name = 'AI Assistant Foundation' AND deleted_at IS NULL) THEN
    RAISE NOTICE 'Project "AI Assistant Foundation" already exists — nothing done.';
    RETURN;
  END IF;

  INSERT INTO pm_projects (name, description, status, priority, sort_order)
  VALUES (
    'AI Assistant Foundation',
    'Foundation for the AI-assistant add-on tier (eventual goal: autonomous TC-level assistant). '
    || 'Phase 0 decisions + Phase 1 data-layer work: append-only observation ledger, evidence links, '
    || 'non-destructive identity, and inference write-path fixes. Base product (import/export) is never '
    || 'modified — new layer is write-beside, feature-flagged, and only the future AI tier reads it.',
    'planned',
    'high',
    100
  )
  RETURNING id INTO v_project_id;

  SELECT COALESCE(MAX(item_number), 0) INTO v_base FROM pm_backlog_items;

  -- ---------------------------------------------------------------
  -- Epic 1 [P0] Decision doc: privacy envelope, LLM economics, autonomy ladder
  -- ---------------------------------------------------------------
  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 1), v_base + 1,
    '[P0] Decision doc: privacy envelope, LLM economics, autonomy ladder',
    'One-page written decisions that gate all later phases. No code.',
    E'## Goal\nWrite down the three decisions that gate Phases 3-5, before first users onboard (the promises are free to set now, expensive to change later).\n\n## Decisions to make\n1. **Privacy envelope** — what may leave the device and under what consent. Recommended framing: "end-to-end encrypted, you hold the keys, AI processing only with consent" instead of "nothing ever leaves your machine" (the latter forecloses the assistant tier).\n2. **LLM economics** — managed/metered first-party inference vs BYO-key, and the default for the add-on tier. Note: Phases 1-2 need zero LLM either way.\n3. **Autonomy ladder** — per-action-type graduation for the future assistant: draft -> agent approves -> auto, with outward-facing actions gated longest.\n\n## Acceptance\n- Doc reviewed and agreed by founder; stored in repo docs/.\n- Tier model stated: base = compliance/audit (unchanged), add-on = AI tier; base-tier usage accumulates ledger + corrections locally with no LLM calls and no content leaving the device.',
    'epic', 'critical', 'pending', v_project_id, 30000, 1
  ) RETURNING id INTO v_item;
  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation'));

  -- ---------------------------------------------------------------
  -- Epic 2 [P1] Golden-path characterization tests (import -> export)
  -- ---------------------------------------------------------------
  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 2), v_base + 2,
    '[P1] Golden-path characterization tests for import -> export',
    'Snapshot today''s working behavior before any foundation work, so regressions scream immediately.',
    E'## Goal\nProtect what works perfectly today (ingestion + audit export) before touching anything. This epic lands FIRST.\n\n## Scope\n- Characterization tests over the golden path: provider fixtures -> ingest (email + messages + attachments) -> auto-link -> transaction detail -> export package (PDF/folder) -> assert package contents/structure.\n- Reuse existing fixtures (fake-mailbox, fake-ios-backup) and e2e harness.\n- Snapshot key invariants: message counts, link rows, participant roles, export manifest.\n\n## Acceptance\n- CI job fails if import or export output changes shape unexpectedly.\n- Documented invariants list checked into tests.',
    'epic', 'high', 'pending', v_project_id, 120000, 2
  ) RETURNING id INTO v_item;
  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation'));

  -- ---------------------------------------------------------------
  -- Epic 3 [P1] Observation event ledger (shadow, write-beside)
  -- ---------------------------------------------------------------
  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 3), v_base + 3,
    '[P1] Observation event ledger (shadow, write-beside)',
    'Append-only local ledger of what the system observed and inferred, tapped from existing pipelines. Base product never reads it.',
    E'## Goal\nStop losing history: record "at time T, from source S, we observed/inferred X (confidence C)" for every ingest and inference change. This is the raw material the AI tier later replays over ("flip the switch -> works right away").\n\n## Design guardrails (tap, don''t touch)\n- New append-only SQLite table(s); writers are taps AFTER existing writes succeed.\n- Every tap wrapped in its own try/catch — a ledger failure must NEVER break ingestion.\n- Feature-flagged; base product has zero read paths into the ledger.\n- State tables remain operational source of truth indefinitely (shadow ledger, no inversion).\n\n## Scope\n- Schema: entity_type, entity_id, event_type, source, payload/before-after, confidence, observed_at, evidence_ref.\n- Tap points: email sync, iPhone/Android message import, attachment ingest, auto-link/unlink, transaction detection, role assignment, dedup decisions, removals/restores.\n- Extractor re-runs append observations for already-known transactions instead of silent skip.\n\n## Acceptance\n- Fresh sync on a fixture mailbox produces a coherent, ordered event stream.\n- Kill-switch flag verified; characterization tests (Epic 2) stay green with ledger on and off.',
    'epic', 'high', 'pending', v_project_id, 250000, 3
  ) RETURNING id INTO v_item;
  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation'));

  -- ---------------------------------------------------------------
  -- Epic 4 [P1] Evidence linking for inferences
  -- ---------------------------------------------------------------
  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 4), v_base + 4,
    '[P1] Evidence linking for inferences',
    'Every inference (role, stage, detection, link) gets structural pointers to the communications/attachments that support it.',
    E'## Goal\nMake "why do we believe this" a queryable relation instead of free text inside JSON blobs. Compliance-grade provenance is also the product''s core value.\n\n## Scope\n- Evidence table: inference ref -> (communication_id | attachment_id, optional quote/span).\n- Wire writers where inferences are produced today: transaction detection, role assignment (transaction_contacts), stage hints, auto-link decisions.\n- Shape defined now even if some producers backfill later; ledger events carry evidence_ref (Epic 3 dependency).\n\n## Acceptance\n- For a detected transaction on fixture data: every role and stage inference resolves to at least one concrete source row.\n- No change to base-product read paths.',
    'epic', 'high', 'pending', v_project_id, 180000, 4
  ) RETURNING id INTO v_item;
  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation'));

  -- ---------------------------------------------------------------
  -- Epic 5 [P1] Non-destructive identity: contacts (extend removed pattern)
  -- ---------------------------------------------------------------
  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 5), v_base + 5,
    '[P1] Non-destructive identity: contacts (extend removed pattern)',
    'Contact delete stops being a hard DELETE + cascade; dedup collapses get recorded. Follows the shipped ignored_communications / email_tombstones idioms.',
    E'## Goal\nClose the last true one-way door: today deleting a contact hard-deletes and cascades away its emails, phones, and every transaction role-link; import dedup silently discards the losing identity.\n\n## Scope\n- Tombstone contacts (removed_at/removed_reason) instead of DELETE; filter removed contacts from pickers/lists.\n- "Removed contacts" section with restore, reusing the generic RemovedItemsSection + useRemovedSection UI idiom.\n- Record dedup collapses (which source identities merged into which contact) in the ledger instead of skip-and-forget.\n- Groundwork for canonical person id: keep source identities linked (external_contacts as seed).\n\n## Guardrails\n- No fuzzy matching in this epic — deterministic matching stays as-is; this only stops destroying the substrate a future resolver needs.\n- Removals double as negative training signal for the AI tier (same as ignored_communications for auto-link).\n\n## Acceptance\n- Remove -> restore round-trip test for contacts (mirror of the existing r5Cycle test for threads).\n- Cascade no longer destroys transaction_contacts/participant history on removal.',
    'epic', 'high', 'pending', v_project_id, 200000, 5
  ) RETURNING id INTO v_item;
  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation'));

  -- ---------------------------------------------------------------
  -- Epic 6 [P1] Extend removed pattern: attachments (file vs record split)
  -- ---------------------------------------------------------------
  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 6), v_base + 6,
    '[P1] Extend removed pattern: attachments (file vs record split)',
    'Removing an attachment can delete the file from disk but keeps the row, extracted text, and a tombstone with reason.',
    E'## Goal\nUsers reclaim storage without erasing business facts: "an inspection report existed on March 3rd" survives after the 40MB PDF is gone.\n\n## Scope\n- Tombstone semantics on attachments (removed_at/removed_reason), file deletion decoupled from record deletion.\n- Keep text_content + classification metadata on removed attachments.\n- Removed-attachments visibility via the shared removed-section idiom; restore where the file still exists (or re-fetchable from provider).\n- Removal events recorded in the ledger.\n\n## Acceptance\n- Removing an attachment frees disk, keeps the row + extracted text, and export/audit continues to reference the fact of the document.\n- Calendar events (future ingestion) noted as design dependents: cancellations are observations, never hard-deletes.',
    'epic', 'medium', 'pending', v_project_id, 100000, 6
  ) RETURNING id INTO v_item;
  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation'));

  -- ---------------------------------------------------------------
  -- Epic 7 [P1] Inference write-path fixes (persist confidence, record re-runs)
  -- ---------------------------------------------------------------
  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 7), v_base + 7,
    '[P1] Inference write-path fixes: persist detection confidence, record re-runs',
    'Detection confidence/method assembled by the detector is currently dropped at INSERT (not in the column whitelist); extractor re-runs skip-and-discard.',
    E'## Goal\nMake the confidence/provenance columns that already exist in the schema actually receive the values the code already computes.\n\n## Scope\n- Add detection_status/detection_confidence/detection_method (+ extraction confidence) to the transaction INSERT/UPDATE whitelists so detector output persists.\n- Extractor re-run behavior: on encountering an existing transaction, append the newly derived observation to the ledger (Epic 3) instead of silent skip — state tables unchanged.\n- Dead tables decision: with no installed base, drop or fold transaction_stage_history and extracted_transaction_data into the ledger design rather than reviving two parallel history mechanisms.\n\n## Acceptance\n- Fixture-mailbox detection run persists non-NULL confidence/method on created transactions.\n- Re-running detection on the same fixtures adds ledger observations, changes no state, and characterization tests stay green.',
    'epic', 'medium', 'pending', v_project_id, 80000, 7
  ) RETURNING id INTO v_item;
  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation'));

  RAISE NOTICE 'Created project % with epics BACKLOG-% .. BACKLOG-%', v_project_id, v_base + 1, v_base + 7;
END $$;
