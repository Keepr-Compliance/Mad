-- Version 20260804153801 / pm_agent_activity_registry
--
-- BACKLOG-2658. This file is written AFTER the fact. The objects below already
-- exist in production: they were applied on 2026-08-04 with `apply_migration`,
-- which records a version in `supabase_migrations.schema_migrations` and writes
-- no file. There was therefore nothing to review, and a rebuilt environment did
-- not get the table at all. This file closes that gap.
--
-- TRANSCRIBED FROM LIVE, not from memory and not from the ticket:
--   information_schema.columns / pg_indexes / pg_constraint  -> table shape
--   pg_get_viewdef(oid, true)                                -> the three views
--   obj_description / col_description                        -> the comments
--
-- ONE DELIBERATE DIVERGENCE FROM THE RECORDED 2026-08-04 STATEMENT.
-- `pm_agent_bypassed` in production no longer matches what version
-- 20260804153801 recorded. The recorded statement had a fixed window:
--
--     WHERE a.agent_id IS NULL
--       AND m.recorded_at > now() - interval '7 days'
--
-- Production instead counts from the first registration onward. That change was
-- applied to production as raw DDL with NO migration version and NO statements
-- row anywhere in the history — so unlike the 32 fileless migrations, there is
-- no version string to hang it on, and inventing one is not allowed. Per the
-- BACKLOG-2658 rule "the live object wins and the difference is recorded", the
-- live definition and the live comment are what this file reproduces. Recorded
-- separately as its own finding; see the PR body and pm_comments.
--
-- Grants are NOT restated here: pg_class.relacl for all four objects holds only
-- Supabase's default public-schema grants (anon/authenticated/service_role),
-- which the original migration never issued and which apply automatically.

-- Live registry of what each agent is working on.
-- Purpose: situational awareness. pm_token_metrics records what an agent SPENT
-- once it finished; nothing recorded what was moving right now. On 2026-08-04
-- that gap produced two agents rewriting the same file unaware of each other,
-- four merge-order conclusions (two wrong, measured against branches that then
-- moved), and two scratchpad collisions.

CREATE TABLE IF NOT EXISTS pm_agent_activity (
  agent_id        text PRIMARY KEY,
  agent_type      text,
  legacy_id       text,
  description     text,
  branch_name     text,
  worktree_path   text,
  files_claimed   text[] DEFAULT '{}',
  head_sha        text,
  status          text NOT NULL DEFAULT 'working'
                    CHECK (status IN ('working','review','blocked','done')),
  note            text,
  session_id      text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  heartbeat_at    timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

COMMENT ON TABLE pm_agent_activity IS
  'Live agent registry. Written by the PostToolUse:Agent hook at launch and refreshed by the PostToolUse:Edit|Write hook. Non-blocking by design: a failure here must never stop work. Bypasses are detectable via pm_agent_bypassed.';
COMMENT ON COLUMN pm_agent_activity.files_claimed IS
  'DETECTED from git diff at heartbeat, not declared. A declared list goes stale the moment scope changes.';
COMMENT ON COLUMN pm_agent_activity.head_sha IS
  'The SHA any cross-branch claim was measured at. A claim without one is unverifiable an hour later.';

CREATE INDEX IF NOT EXISTS idx_pm_agent_activity_heartbeat ON pm_agent_activity (heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_agent_activity_legacy ON pm_agent_activity (legacy_id);
CREATE INDEX IF NOT EXISTS idx_pm_agent_activity_files ON pm_agent_activity USING GIN (files_claimed);

-- What is moving right now, and who else is touching my files.
CREATE OR REPLACE VIEW pm_agents_active AS
SELECT agent_id, agent_type, legacy_id, description, branch_name, status, note,
       files_claimed,
       round(EXTRACT(epoch FROM (now() - heartbeat_at)) / 60)::int AS minutes_since_heartbeat,
       started_at
FROM pm_agent_activity
WHERE ended_at IS NULL
  AND heartbeat_at > now() - interval '2 hours'
ORDER BY heartbeat_at DESC;

COMMENT ON VIEW pm_agents_active IS
  'Pre-flight check before claiming anything about another branch, or editing a shared file.';

-- The auditor. An agent that finished (and so appears in pm_token_metrics)
-- but never registered has bypassed the hook. Non-blocking hooks fail silently;
-- this is what makes that visible rather than assumed.
--
-- The lower bound is the first registration, not a rolling 7-day window: before
-- the hook existed every completed agent would read as a bypass.
CREATE OR REPLACE VIEW pm_agent_bypassed AS
SELECT DISTINCT m.agent_id, m.agent_type, m.task_id, m.recorded_at
FROM pm_token_metrics m
LEFT JOIN pm_agent_activity a ON a.agent_id = m.agent_id
WHERE a.agent_id IS NULL
  AND m.recorded_at > (SELECT COALESCE(min(started_at), now()) FROM pm_agent_activity)
ORDER BY m.recorded_at DESC;

COMMENT ON VIEW pm_agent_bypassed IS
  'Agents that ran but never registered, counted only from the first registration onward — before that the hook did not exist and every agent would read as a bypass. A steady trickle means the hook is broken; a spike means agents are working outside the harness.';

-- Two agents editing the same file, neither necessarily aware.
CREATE OR REPLACE VIEW pm_agent_file_collisions AS
SELECT f.file, count(*) AS agents,
       string_agg(a.agent_id || ' (' || COALESCE(a.legacy_id,'?') || ')', ', ') AS who
FROM pm_agent_activity a
CROSS JOIN LATERAL unnest(a.files_claimed) AS f(file)
WHERE a.ended_at IS NULL
  AND a.heartbeat_at > now() - interval '2 hours'
GROUP BY f.file
HAVING count(*) > 1
ORDER BY count(*) DESC;

COMMENT ON VIEW pm_agent_file_collisions IS
  'Surfaces the 2026-08-04 failure at the first edit rather than three reviews later.';
