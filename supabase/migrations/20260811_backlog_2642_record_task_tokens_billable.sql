-- ============================================================================
-- BACKLOG-2642: pm_record_task_tokens — three defects
--
-- Supersedes the definition in 20260327_pm_token_metrics_v2.sql (section 5).
--
-- 1. The aggregate summed `total_tokens`, which includes `cache_read_tokens`.
--    Measured 2026-08-11 over 2,756 rows: sum(total_tokens) = 15,850,417,011 vs
--    sum(billable_tokens) = 813,978,827 — 19.47x inflation. Every metric-era
--    `variance` inherited that error. Now sums `billable_tokens`.
--    Null-safety of the swap, measured: billable_tokens NULL on 0 rows;
--    billable_tokens > total_tokens on 0 rows.
--
-- 2. It INSERTed a synthetic aggregate row back into pm_token_metrics using the
--    sum it had just computed. REMOVED — see the rationale block below.
--
-- 3. It joined on the TEXT `task_id`. Now keyed on uuids, with a text fallback
--    only for rows that carry no uuid.
--
-- ---------------------------------------------------------------------------
-- WHY THE SYNTHETIC INSERT IS REMOVED RATHER THAN CORRECTED
--
--   * `pm_token_metrics.billable_tokens` is GENERATED ALWAYS AS
--     (COALESCE(input,0) + COALESCE(output,0) + COALESCE(cache_creation,0)).
--     Any row this function inserts therefore enters the very pool it just
--     summed, whatever value is written into `total_tokens`. Correcting
--     `total_tokens` to a real gross figure does NOT stop the compounding.
--   * The ON CONFLICT guard rode a PARTIAL unique index
--     (agent_id, session_id) WHERE agent_id IS NOT NULL AND session_id IS NOT
--     NULL. A NULL session_id inserted an unbounded duplicate on every call.
--   * Section 5's own header comment in 20260327 already declared the insert
--     gone ("No longer inserts a duplicate audit row (hook-inserted rows are
--     the audit trail)"). The code contradicted its stated intent.
--   * No live caller passes p_agent_id. admin-portal/lib/pm-queries.ts
--     `recordTaskTokens` is exported and never called; the documented use in
--     .github/PULL_REQUEST_TEMPLATE.md is one-argument.
--
--   The 11-parameter signature is KEPT so admin-portal continues to compile.
--   The metric-writing parameters are accepted and ignored; the return payload
--   carries `agent_metrics_written: false` so a caller can detect it. Writing
--   metric rows belongs to pm_log_agent_metrics (the hook path).
--
--   Consequence, and the point: this function no longer writes to
--   pm_token_metrics at all, so calling it twice cannot compound. That is
--   structural, not a guard that could be bypassed.
--
-- ---------------------------------------------------------------------------
-- WHY THE PARENT ROLLUP IS REDEFINED
--
--   pm_backlog_items.actual_tokens was SUM(child pm_tasks.actual_tokens).
--   pm_log_agent_metrics resolves task_uuid via pm_tasks.legacy_id = p_task_id.
--   The post-#2280 hook sends p_task_id = 'BACKLOG-nnnn' and an explicit
--   p_backlog_item_id; no pm_tasks row carries a BACKLOG-% legacy_id, so those
--   rows land with task_uuid NULL and backlog_item_id set. They are reachable
--   from no task at all.
--
--   Measured 2026-08-11: task_uuid resolves on 149 of 2,756 rows; 361 carry
--   backlog_item_id; 838 have a task_id text that matches a backlog item.
--   Worked example — BACKLOG-1459, corrected actual 1,638,790, billable
--   reachable via its child task = 0.
--
--   The 2026-08-11 89-row correction attributed metrics to items as
--   COALESCE(m.backlog_item_id,
--            pm_tasks.backlog_item_id       via pm_tasks.legacy_id = m.task_id,
--            pm_backlog_items.id            via pm_backlog_items.legacy_id = m.task_id).
--   That predicate reproduces all 77 recomputed items EXACTLY (77 match, 0
--   differ). It is encoded verbatim below so the correction stops rotting.
--
--   pm_tasks.actual_tokens stays TASK-keyed. Item-keyed rows are not pushed
--   down to a task: 5 items have more than one child task, and splitting an
--   item pool across them would be a guess.
--
-- ---------------------------------------------------------------------------
-- SILENT-ZERO GUARDS
--
--   * RAISE only when p_actual_tokens IS NULL AND both pools are empty.
--     A modern task legitimately has 0 task-keyed rows and N item-keyed rows.
--   * When the task pool is empty, pm_tasks.actual_tokens is LEFT UNTOUCHED —
--     never written as 0, never given the item pool.
--   * The parent update and `variance` are skipped entirely when the item pool
--     is empty, so a caller-supplied p_actual_tokens can never blank the 83
--     hand-set legacy actuals.
--   * `variance` is NULL, not wrong, when est_tokens is absent or zero.
--
-- KNOWN RESIDUAL: the correction NULLed 12 items as untrusted. BACKLOG-1562 and
-- BACKLOG-1406 have a child task and would be repopulated from their untrusted
-- metrics by a future call. The trust rule is a data-cleanup heuristic and is
-- deliberately NOT encoded here. The other 10 have no child task.
--
-- cost_usd stays NULL: not computable from recorded data (model is 'unknown' on
-- legacy rows, and no rate table is recorded). Out of scope, per #2280.
--
-- ---------------------------------------------------------------------------
-- PRIOR DEFINITION, captured verbatim 2026-08-11 via pg_get_functiondef for
-- reversibility. To roll back, execute exactly this block.
--
-- CREATE OR REPLACE FUNCTION public.pm_record_task_tokens(p_task_id uuid, p_actual_tokens integer DEFAULT NULL::integer, p_agent_id text DEFAULT NULL::text, p_agent_type text DEFAULT NULL::text, p_input_tokens integer DEFAULT NULL::integer, p_output_tokens integer DEFAULT NULL::integer, p_cache_read integer DEFAULT NULL::integer, p_cache_create integer DEFAULT NULL::integer, p_duration_ms integer DEFAULT NULL::integer, p_api_calls integer DEFAULT NULL::integer, p_session_id text DEFAULT NULL::text)
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_task RECORD;
--   v_computed_tokens INT;
--   v_final_tokens INT;
--   v_parent_actual INT;
--   v_parent_est INT;
--   v_variance NUMERIC(8,2);
--   v_metric_id UUID;
--   v_metric_count INT;
-- BEGIN
--   SELECT id, legacy_id, backlog_item_id
--   INTO v_task
--   FROM pm_tasks
--   WHERE id = p_task_id AND deleted_at IS NULL;
--
--   IF v_task IS NULL THEN
--     RAISE EXCEPTION 'Task not found: %', p_task_id;
--   END IF;
--
--   IF p_actual_tokens IS NULL THEN
--     SELECT COALESCE(SUM(total_tokens), 0), COUNT(*)
--     INTO v_computed_tokens, v_metric_count
--     FROM pm_token_metrics
--     WHERE task_id = v_task.legacy_id;
--
--     IF v_metric_count = 0 THEN
--       RAISE EXCEPTION 'No metric rows found for task % - cannot auto-compute tokens.', v_task.legacy_id;
--     END IF;
--
--     v_final_tokens := v_computed_tokens;
--   ELSE
--     v_final_tokens := p_actual_tokens;
--   END IF;
--
--   IF v_final_tokens < 0 THEN
--     RAISE EXCEPTION 'actual_tokens must be a non-negative integer';
--   END IF;
--
--   UPDATE pm_tasks
--   SET actual_tokens = v_final_tokens,
--       updated_at = now()
--   WHERE id = p_task_id;
--
--   IF p_agent_id IS NOT NULL THEN
--     INSERT INTO pm_token_metrics (
--       agent_id, agent_type, task_id, task_uuid, backlog_item_id, sprint_id,
--       input_tokens, output_tokens, total_tokens,
--       cache_read_tokens, cache_creation_tokens,
--       duration_ms, api_calls, session_id
--     ) VALUES (
--       p_agent_id, p_agent_type, v_task.legacy_id, p_task_id, v_task.backlog_item_id,
--       (SELECT sprint_id FROM pm_tasks WHERE id = p_task_id),
--       p_input_tokens, p_output_tokens, v_final_tokens,
--       p_cache_read, p_cache_create,
--       p_duration_ms, p_api_calls, p_session_id
--     )
--     ON CONFLICT (agent_id, session_id) WHERE agent_id IS NOT NULL AND session_id IS NOT NULL
--     DO NOTHING
--     RETURNING id INTO v_metric_id;
--   END IF;
--
--   IF v_task.backlog_item_id IS NOT NULL THEN
--     SELECT COALESCE(SUM(actual_tokens), 0)
--     INTO v_parent_actual
--     FROM pm_tasks
--     WHERE backlog_item_id = v_task.backlog_item_id
--       AND deleted_at IS NULL
--       AND actual_tokens IS NOT NULL;
--
--     SELECT est_tokens
--     INTO v_parent_est
--     FROM pm_backlog_items
--     WHERE id = v_task.backlog_item_id;
--
--     IF v_parent_est IS NOT NULL AND v_parent_est > 0 THEN
--       v_variance := ((v_parent_actual - v_parent_est)::NUMERIC / v_parent_est * 100);
--     ELSE
--       v_variance := NULL;
--     END IF;
--
--     UPDATE pm_backlog_items
--     SET actual_tokens = v_parent_actual,
--         variance = v_variance,
--         updated_at = now()
--     WHERE id = v_task.backlog_item_id;
--   END IF;
--
--   RETURN jsonb_build_object(
--     'success', true,
--     'task_id', p_task_id,
--     'actual_tokens', v_final_tokens,
--     'auto_computed', p_actual_tokens IS NULL,
--     'metric_count', v_metric_count,
--     'parent_actual', v_parent_actual,
--     'variance', v_variance
--   );
-- END;
-- $function$
-- ============================================================================

CREATE OR REPLACE FUNCTION pm_record_task_tokens(
  p_task_id UUID,
  p_actual_tokens INT DEFAULT NULL,
  -- Accepted for signature compatibility with admin-portal; IGNORED.
  -- Metric rows are written by pm_log_agent_metrics (the hook path).
  p_agent_id TEXT DEFAULT NULL,
  p_agent_type TEXT DEFAULT NULL,
  p_input_tokens INT DEFAULT NULL,
  p_output_tokens INT DEFAULT NULL,
  p_cache_read INT DEFAULT NULL,
  p_cache_create INT DEFAULT NULL,
  p_duration_ms INT DEFAULT NULL,
  p_api_calls INT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task RECORD;
  v_final_tokens INT;          -- NULL means "leave pm_tasks.actual_tokens alone"
  v_task_billable INT;
  v_task_metric_count INT := 0;
  v_item_billable INT;
  v_item_metric_count INT := 0;
  v_parent_actual INT;
  v_parent_est INT;
  v_variance NUMERIC(8,2);
BEGIN
  -- Validate task exists
  SELECT id, legacy_id, backlog_item_id
  INTO v_task
  FROM pm_tasks
  WHERE id = p_task_id AND deleted_at IS NULL;

  IF v_task IS NULL THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;

  -- ---------------------------------------------------------------------
  -- Pool A — rows keyed to THIS TASK.
  -- uuid first; text only for rows that carry no uuid, so a row can never be
  -- counted twice and a uuid always wins over a stale text label.
  -- ---------------------------------------------------------------------
  SELECT COALESCE(SUM(m.billable_tokens), 0), COUNT(*)
  INTO v_task_billable, v_task_metric_count
  FROM pm_token_metrics m
  WHERE m.task_uuid = p_task_id
     OR (m.task_uuid IS NULL AND v_task.legacy_id IS NOT NULL AND m.task_id = v_task.legacy_id);

  -- ---------------------------------------------------------------------
  -- Pool B — rows attributed to the PARENT ITEM.
  -- Verbatim the attribution used by the 2026-08-11 correction; reproduces
  -- all 77 recomputed items exactly.
  -- ---------------------------------------------------------------------
  IF v_task.backlog_item_id IS NOT NULL THEN
    SELECT COALESCE(SUM(m.billable_tokens), 0), COUNT(*)
    INTO v_item_billable, v_item_metric_count
    FROM pm_token_metrics m
    LEFT JOIN pm_tasks t ON t.legacy_id = m.task_id AND t.deleted_at IS NULL
    LEFT JOIN pm_backlog_items bi ON bi.legacy_id = m.task_id
    WHERE COALESCE(m.backlog_item_id, t.backlog_item_id, bi.id) = v_task.backlog_item_id;
  END IF;

  -- ---------------------------------------------------------------------
  -- Decide pm_tasks.actual_tokens
  -- ---------------------------------------------------------------------
  IF p_actual_tokens IS NOT NULL THEN
    v_final_tokens := p_actual_tokens;

    IF v_final_tokens < 0 THEN
      RAISE EXCEPTION 'actual_tokens must be a non-negative integer';
    END IF;
  ELSIF v_task_metric_count > 0 THEN
    v_final_tokens := v_task_billable;
  ELSIF v_item_metric_count > 0 THEN
    -- Modern shape: metrics exist for the item but none are keyed to this
    -- task. Do NOT invent a task-level number (an item may have several
    -- tasks); leave pm_tasks.actual_tokens as it is and roll the item up.
    v_final_tokens := NULL;
  ELSE
    RAISE EXCEPTION
      'No metric rows found for task % (uuid %) or its parent item — cannot auto-compute tokens.',
      v_task.legacy_id, p_task_id;
  END IF;

  IF v_final_tokens IS NOT NULL THEN
    UPDATE pm_tasks
    SET actual_tokens = v_final_tokens,
        updated_at = now()
    WHERE id = p_task_id;
  END IF;

  -- ---------------------------------------------------------------------
  -- Parent rollup. Skipped entirely when the item pool is empty, so this can
  -- never overwrite a hand-set actual with 0.
  -- ---------------------------------------------------------------------
  IF v_task.backlog_item_id IS NOT NULL AND v_item_metric_count > 0 THEN
    v_parent_actual := v_item_billable;

    SELECT est_tokens
    INTO v_parent_est
    FROM pm_backlog_items
    WHERE id = v_task.backlog_item_id;

    -- variance: ((actual - est) / est * 100), NULL when est is absent or zero
    IF v_parent_est IS NOT NULL AND v_parent_est > 0 THEN
      v_variance := ((v_parent_actual - v_parent_est)::NUMERIC / v_parent_est * 100);
    ELSE
      v_variance := NULL;
    END IF;

    UPDATE pm_backlog_items
    SET actual_tokens = v_parent_actual,
        variance = v_variance,
        updated_at = now()
    WHERE id = v_task.backlog_item_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', p_task_id,
    'actual_tokens', v_final_tokens,
    'auto_computed', p_actual_tokens IS NULL,
    'metric_count', v_task_metric_count,
    'item_metric_count', v_item_metric_count,
    'parent_actual', v_parent_actual,
    'variance', v_variance,
    'agent_metrics_written', false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION pm_record_task_tokens FROM public, anon;
GRANT EXECUTE ON FUNCTION pm_record_task_tokens TO authenticated;
