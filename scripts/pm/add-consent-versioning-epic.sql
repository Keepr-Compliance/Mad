-- ============================================
-- PM Update: add "[P2] Tiered consent & T&C versioning" epic to
-- the AI Assistant Foundation project (founder-identified requirement).
-- Idempotent: guarded on title existence. Run with the decisions script.
-- ============================================

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
  IF EXISTS (SELECT 1 FROM pm_backlog_items WHERE project_id = v_project_id AND deleted_at IS NULL
             AND title LIKE '%Tiered consent%') THEN
    RAISE NOTICE 'Consent epic already exists — nothing done.';
    RETURN;
  END IF;

  SELECT COALESCE(MAX(item_number), 0) INTO v_base FROM pm_backlog_items;

  INSERT INTO pm_backlog_items (legacy_id, item_number, title, description, body, type, priority, status, project_id, est_tokens, sort_order)
  VALUES (
    'BACKLOG-' || (v_base + 1), v_base + 1,
    '[P2] Tiered consent & T&C versioning (consent ledger)',
    'Per-tier T&C variants + separate revocable AI-processing consent, with append-only acceptance history. Needed before external AI-tier testing.',
    E'## Goal\nExtend the existing T&C acceptance system to support the tier ladder: per-tier document requirements, a legally separate (and revocable) AI-processing consent, and audit-grade acceptance history.\n\n## What exists today\nusers.terms_version_accepted / privacy_policy_version_accepted (+ accepted_at) — single current-version slots checked at auth. Gaps: overwrite-in-place (no acceptance history), no tier dimension, no separate AI consent, no revocation model.\n\n## Design — one rule covers all three founder scenarios\nrequired_docs(tier, current_versions) - accepted_docs(user) = delta -> prompt for the delta.\nRun at: signup (new user gets the correct doc set for their tier), login (returning user prompted on new versions), tier change (upgrade prompts only the ADDITIONAL grants — AI tier adds processing consent, premium adds cloud-storage consent).\n\n## Scope\n- Doc registry: doc_type, version, applies_to_tiers, effective_at.\n- Append-only consent_acceptances: user, doc_type, version, tier, accepted_at, app_version, revoked_at. Existing users.* columns kept as a "latest accepted" cache for back-compat.\n- Revocation: withdrawing AI-processing consent immediately stops cloud calls (hard gate).\n- Gating: consent state rides the same check as entitlements (feature available = entitlement AND active consent).\n\n## Acceptance\n- Delta rule unit-tested across the 3 scenarios + revocation.\n- Cloud LLM call paths hard-gated on active consent (verified by test).\n\n## Founder testing gate\n- Founder flips a test account across tiers and sees exactly the right prompts appear (and nothing extra); revokes AI consent and observes cloud processing stop while local features keep working.',
    'epic', 'high', 'pending', v_project_id, 150000, 9
  ) RETURNING id INTO v_item;

  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_item, 'created', 'pending', jsonb_build_object('source', 'claude-session-seed', 'project', 'AI Assistant Foundation', 'note', 'founder-identified requirement: tiered consent/T&C versioning'));

  RAISE NOTICE 'Created consent epic BACKLOG-%', v_base + 1;
END $$;
