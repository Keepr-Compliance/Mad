-- ============================================
-- PM Update: record founder decisions on BACKLOG-2266 (P0 decision doc epic)
-- Session: 2026-07-27. Idempotent: guarded on the section marker.
-- Run via Supabase SQL editor or an approved MCP session.
-- ============================================

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
    RAISE NOTICE 'Decisions already recorded — nothing done.';
    RETURN;
  END IF;

  UPDATE pm_backlog_items SET body = body || E'\n\n## Founder decisions (recorded 2026-07-27)\n\n**1. Privacy envelope = the tier ladder** (privacy level, inference location, and price are one axis):\n- **Base (compliance):** strict local — nothing leaves the device, no AI. Ledger + user corrections still accumulate locally.\n- **AI tier:** local inference by default; cloud PROCESSING-ONLY with explicit consent (no server-side storage). Managed/metered LLM as default, BYO-key as an option where it makes sense.\n- **Premium:** fully consented encrypted cloud corpus — enables any-device/on-the-go access, cross-device unification, background assistant.\n- ACTION (urgent, before first base-tier onboarding): ToS/marketing wording must be consent-ready ("local by default, encrypted, AI features only with your explicit consent") so the AI tiers never require repositioning with the first cohort.\n\n**2. LLM economics:** hybrid escalation ladder — deterministic patterns -> light LOCAL model (first inference rung to build) -> managed cloud for hard tasks (drafting/Q&A), metered into tier price. BYO-key survives as an option, not the default. Local-model packaging (runtime bundling, first-run download, memory) is its own epic when content-understanding tasks arrive — must NOT block the matching feature, which needs no LLM. Provider seam: add "local" as a third provider behind the existing llm/ abstraction now.\n\n**3. Timeline reality:** base-product users onboard SOON (additive-only schema discipline from that point; ledger ships in the first build they install so history capture starts day one). AI-tier testing target: 1-3 months, scoped to matching flow + evidence-backed detection + ledger accumulation (not corpus/graph/assistant).\n\n**4. First buyer: individual agents** (TC-replacement wedge — deadlines, document chasing, next actions). Broker-portal compliance-intelligence wedge comes later.\n\n**Still open (decide before P0 doc closes):**\n- Autonomy ceiling: may the assistant ever auto-send outward communications once trusted, or is draft-for-approval the permanent ceiling?\n- Windows vs Mac share of target users -> local model as default vs Mac-first with cloud fallback.', updated_at = now()
  WHERE id = v_id;

  INSERT INTO pm_events (item_id, event_type, new_value, metadata)
  VALUES (v_id, 'updated', 'body', jsonb_build_object('source', 'claude-session-seed', 'change', 'recorded founder decisions: tiered privacy envelope, hybrid LLM ladder w/ local-first rung, agents as first buyer, onboarding timeline'));

  RAISE NOTICE 'Founder decisions recorded on BACKLOG-2266 (%).', v_id;
END $$;
