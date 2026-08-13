---
name: log-metrics
description: Query and manage agent metrics in Supabase pm_token_metrics table. CSV is append-only backup.
---

# Log Metrics Skill

Agent metrics are **auto-captured by the SubagentStop hook** to Supabase `pm_token_metrics` (primary) and `tokens.csv` (backup). Manual logging is rarely needed.

## How Metrics Flow

```
SubagentStop hook fires
    │
    ├─ Reads .claude/.current-task (task_id, agent_type, sprint_id)
    ├─ Writes to Supabase via pm_log_agent_metrics RPC (PRIMARY)
    ├─ Writes to tokens.csv (BACKUP — append-only, never queried)
    └─ On Supabase failure: saves to ~/.claude/metrics/failed-payloads.jsonl
```

**PM writes `.claude/.current-task` before invoking each agent** (Step 5 of agent-handoff):
```json
{"task_id": "TASK-2226", "agent_type": "engineer", "sprint_id": "<sprint-uuid>"}
```
**CRITICAL: `sprint_id` must be the UUID from `pm_sprints.id`, NOT the sprint name (e.g., "SPRINT-139").**
Using the name causes NULL sprint_id in pm_token_metrics. Incident ref: SPRINT-T.

This eliminates the manual `--label` step — the hook writes task context at insert time.

## Querying Metrics (via MCP)

All metric queries use SQL via `mcp__supabase__execute_sql`:

> **`billable_tokens` is the cost column. Never report `total_tokens` as effort or spend.**
> `total_tokens` includes `cache_read_tokens` and runs ~19x higher — measured 19.54x across
> the whole live table on 2026-08-11 (15,967,627,947 vs 817,061,720).
> `billable_tokens` is `GENERATED ALWAYS AS (input + output + cache_creation)`; cache reads
> are excluded on purpose. Summing the wrong column made every tracker `variance` wrong and
> forced 89 item rows to be recomputed (PR #2282). Below, `total_tokens` appears only in
> full component breakdowns, for diagnosis — not as an answer to "how much did this cost".

### Task totals (replaces `sum_effort.py`)
```sql
SELECT
  task_id,
  SUM(billable_tokens) AS billable_tokens,   -- the cost figure
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_creation_tokens) AS cache_creation_tokens,
  SUM(total_tokens) AS total_tokens,         -- diagnostic only: includes cache reads
  SUM(api_calls) AS api_calls,
  SUM(duration_ms) / 1000 AS duration_secs,
  COUNT(DISTINCT agent_id) AS agent_sessions,
  COUNT(*) AS entries
FROM pm_token_metrics
WHERE task_id = 'TASK-XXXX'
GROUP BY task_id;
```

### Filter by agent type, date, session (replaces `query_metrics.py`)
```sql
-- By agent type
SELECT * FROM pm_token_metrics WHERE agent_type = 'engineer' ORDER BY recorded_at DESC;

-- By date range
SELECT * FROM pm_token_metrics WHERE recorded_at >= '2026-03-01' ORDER BY recorded_at;

-- By session
SELECT * FROM pm_token_metrics WHERE session_id = '<uuid>' ORDER BY recorded_at;

-- Combined
SELECT * FROM pm_token_metrics
WHERE task_id = 'TASK-XXXX' AND recorded_at >= '2026-03-01'
ORDER BY recorded_at;
```

### Sprint-level aggregation
```sql
SELECT
  sprint_id,
  SUM(billable_tokens) AS billable_tokens,   -- the sprint's cost; do NOT sum total_tokens
  COUNT(DISTINCT task_id) AS tasks,
  COUNT(DISTINCT agent_id) AS agents
FROM pm_token_metrics
WHERE sprint_id = '<sprint-uuid>'
GROUP BY sprint_id;
```

## Labeling Unlabeled Rows

If the hook fired without `.current-task` context, use the labeling RPC:

```sql
SELECT pm_label_agent_metrics('<agent_id>', 'TASK-XXXX', 'engineer', 'Implementation');
```

This finds the most recent unlabeled row for that agent_id and sets task_id, agent_type, description, plus resolves task_uuid, backlog_item_id, sprint_id FKs.

## Recording Task Totals (Step 14)

PM calls this at Step 14 — it auto-sums from metric rows:

```sql
-- Auto-compute from pm_token_metrics (preferred — no manual total needed)
SELECT pm_record_task_tokens('<task_uuid>');

-- Or with explicit total (backward compatible)
SELECT pm_record_task_tokens('<task_uuid>', 150000);
```

## Reconciliation (Step 14 pre-flight)

Before recording task totals, verify all agents logged:

```sql
SELECT agent_id, agent_type, billable_tokens, task_id
FROM pm_token_metrics
WHERE task_id = 'TASK-XXXX'
ORDER BY recorded_at;
```

Compare agent_id count against handoff chain. If any are missing, check `~/.claude/metrics/failed-payloads.jsonl` for failed pushes.

## Gap Detection (Sprint Close)

```sql
SELECT t.legacy_id AS task_id, COUNT(m.id) AS metric_rows
FROM pm_tasks t
LEFT JOIN pm_token_metrics m ON m.task_id = t.legacy_id
WHERE t.sprint_id = '<sprint-uuid>' AND t.deleted_at IS NULL
GROUP BY t.legacy_id
HAVING COUNT(m.id) = 0;
```

Any results indicate tasks that completed with zero metric records.

**WARNING:** This query joins on `legacy_id`. If `legacy_id` is NULL on pm_tasks entries,
those tasks silently show zero metric rows (false positive). Ensure all tasks have `legacy_id` set:
`UPDATE pm_backlog_items SET legacy_id = 'TASK-' || item_number WHERE sprint_id = '<sprint-uuid>' AND legacy_id IS NULL;`
Incident ref: SPRINT-T — all tasks had NULL legacy_id, metrics invisible in admin portal.

---

## Deprecated: Python Scripts

The following scripts remain on disk for historical CSV queries but are **not used in the current workflow**:

| Script | Replaced By |
|--------|-------------|
| `log_metrics.py` | Auto-capture via SubagentStop hook |
| `log_metrics.py --label` | `pm_label_agent_metrics` RPC |
| `query_metrics.py` | SQL via MCP |
| `sum_effort.py` | SQL via MCP / `pm_record_task_tokens` auto-sum |

## Billable Tokens Formula

**Standardized**: `billable = input + output + cache_create`

This is a generated column in Supabase (`billable_tokens`), computed automatically. Cache reads are excluded (much cheaper, tracked separately as `cache_read_tokens`).

## Storage

| Store | Role | Location |
|-------|------|----------|
| **Supabase** | Primary (source of truth) | `pm_token_metrics` table |
| **CSV** | Backup (append-only, never queried) | `.claude/metrics/tokens.csv` |
| **Failed payloads** | Replay queue | `~/.claude/metrics/failed-payloads.jsonl` |
