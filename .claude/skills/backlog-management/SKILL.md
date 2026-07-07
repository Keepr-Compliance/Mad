---
name: backlog-management
description: Query, update, and manage the project backlog using the Supabase-backed system.
---

# Backlog Management Skill

This skill provides workflows for managing the project backlog. The backlog uses a Supabase-backed system with RPC functions for efficient querying and data integrity.

> **Note:** Legacy CSV files are preserved in `.claude/plans/backlog/data/` for reference but are NO LONGER the source of truth. Supabase is the authoritative data store.

---

## System Overview

```
Supabase (source of truth)
├── pm_backlog_items         # Main table
├── pm_sprints               # Sprint history
├── pm_sprint_items          # Sprint-to-item assignments
├── pm_changelog             # Audit trail
└── pm_* RPCs                # Query & mutation functions

.claude/plans/backlog/ (read-only archive)
├── data/
│   ├── backlog.csv          # Archived CSV (read-only)
│   ├── sprints.csv          # Archived sprint history
│   ├── changelog.csv        # Archived audit trail
│   └── SCHEMA.md            # Column definitions (reference)
├── scripts/
│   ├── queries.py           # Legacy query interface (still works)
│   └── validate.py          # Legacy schema validation
├── items/                   # BACKLOG-XXX.md detail files
└── README.md                # Quick start guide
```

---

## Quick Reference

### Query Items (Supabase MCP)

```sql
-- By status
SELECT * FROM pm_backlog_items WHERE status = 'pending' AND deleted_at IS NULL ORDER BY priority, created_at;

-- By priority
SELECT * FROM pm_backlog_items WHERE priority = 'high' AND status = 'pending' AND deleted_at IS NULL;

-- Sprint items
SELECT i.* FROM pm_backlog_items i
  JOIN pm_sprint_items si ON si.item_id = i.id
  JOIN pm_sprints s ON s.id = si.sprint_id
  WHERE s.name = 'SPRINT-042' AND i.deleted_at IS NULL;

-- Search
SELECT * FROM pm_backlog_items WHERE title ILIKE '%sync%' AND deleted_at IS NULL;

-- Statistics
SELECT status, COUNT(*) FROM pm_backlog_items WHERE deleted_at IS NULL GROUP BY status;
```

Use the Supabase MCP tool `mcp__supabase__execute_sql` to run these queries.

### Using RPCs (Preferred)

```sql
-- List items with filters
SELECT pm_list_items(p_status := 'pending', p_priority := 'high');

-- Get item by legacy ID (BACKLOG-XXX)
SELECT pm_get_item_by_legacy_id('BACKLOG-746');

-- Get item detail
SELECT pm_get_item_detail('<uuid>');

-- Create item
SELECT pm_create_item(p_title := 'New feature', p_type := 'feature', p_priority := 'high');

-- Update status
SELECT pm_update_item_status('<uuid>', 'in_progress');

-- List sprints
SELECT pm_list_sprints();

-- Create sprint
SELECT pm_create_sprint(p_name := 'SPRINT-140', p_goal := 'Sprint goal');

-- Assign item to sprint (first arg is an ARRAY — uuid[])
SELECT pm_assign_to_sprint(p_item_ids := ARRAY['<uuid>']::uuid[], p_sprint_id := '<uuid>');
```

### Legacy CSV Query (still works, read-only)

```bash
# These scripts still work for backward compatibility
python .claude/plans/backlog/scripts/queries.py status pending
python .claude/plans/backlog/scripts/queries.py priority high --status pending
python .claude/plans/backlog/scripts/queries.py sprint SPRINT-042
python .claude/plans/backlog/scripts/queries.py search "sync"
python .claude/plans/backlog/scripts/queries.py stats
```

---

## Available RPCs (Common Operations)

| Operation | RPC | Example |
|-----------|-----|---------|
| List/filter items | `pm_list_items(p_status, p_priority, ...)` | `SELECT pm_list_items(p_status := 'pending');` |
| Create item | `pm_create_item(p_title, p_type, p_priority, ...)` | `SELECT pm_create_item(p_title := 'Fix login', p_type := 'bug', p_priority := 'high');` |
| Update status | `pm_update_item_status(p_item_id, p_new_status)` | `SELECT pm_update_item_status('<uuid>', 'in_progress');` |
| Get by legacy ID | `pm_get_item_by_legacy_id(p_legacy_id)` | `SELECT pm_get_item_by_legacy_id('BACKLOG-746');` |
| Get item detail | `pm_get_item_detail(p_item_id)` | `SELECT pm_get_item_detail('<uuid>');` |
| List sprints | `pm_list_sprints()` | `SELECT pm_list_sprints();` |
| Create sprint | `pm_create_sprint(p_name, p_goal)` | `SELECT pm_create_sprint(p_name := 'SPRINT-140', p_goal := 'Goal');` |
| Assign to sprint | `pm_assign_to_sprint(p_item_ids uuid[], p_sprint_id uuid)` | `SELECT pm_assign_to_sprint(p_item_ids := ARRAY['<item_uuid>']::uuid[], p_sprint_id := '<sprint_uuid>');` |

---

## MCP Fallback: Creating Items Without RPCs

The `pm_*` RPCs above are guarded by an `internal_roles` check and FAIL from MCP sessions with "Access denied: internal role required" (see CLAUDE.md → "Supabase PM RPCs vs MCP sessions"). From an MCP session, use direct SQL and verify atomically via `RETURNING`:

```sql
-- 1. Next number
SELECT MAX(item_number) + 1 AS next_num FROM pm_backlog_items;

-- 2. Insert with manual item_number + legacy_id; RETURNING confirms the row exists
INSERT INTO pm_backlog_items (item_number, legacy_id, title, description, type, area, priority, status, est_tokens, start_date)
VALUES (<next_num>, 'BACKLOG-<next_num>', '<title>', '<description>',
        '<bug|feature|chore|improvement>', '<area>', '<critical|high|medium|low>',
        'pending', <est_tokens>, CURRENT_DATE)
RETURNING id, item_number, legacy_id;

-- 3. (Optional, audit trail) record the creation event
INSERT INTO pm_events (item_id, actor_id, event_type, new_value, metadata)
VALUES ('<returned id>', '<user uuid>', 'created', 'pending',
        jsonb_build_object('source', 'claude-cli'));
```

Do NOT report the item as created unless the `RETURNING` row came back. Status/field updates work the same way (direct `UPDATE ... RETURNING`). Unguarded RPCs that DO work from MCP sessions: `pm_record_task_tokens`, `pm_label_agent_metrics`.

### Guarded writes (MANDATORY when 2+ sessions may be live)

Always constrain UPDATEs with the expected current state and check the row count:

```sql
UPDATE pm_backlog_items
SET status = 'deferred', updated_at = now()
WHERE legacy_id = 'BACKLOG-####'
  AND status = 'pending'          -- the status you BELIEVE it has
RETURNING legacy_id, status;
```

**Zero rows returned = another session already acted.** Re-read the row before proceeding — never blind-write, never blind-append comments. (Incident 2026-07-07: a parallel session deferred two items minutes earlier; the guard turned a double-write into a harmless no-op.)

---

## Workflows

| Workflow | When to Use |
|----------|-------------|
| [Backlog Analysis](workflows/backlog-analysis.md) | Generate health report, find attention items |
| [Add Item](workflows/add-item.md) | Creating a new backlog item |
| [Close Item](workflows/close-item.md) | Completing or obsoleting an item |
| [Sprint Planning](workflows/sprint-planning.md) | Planning a new sprint |

---

## Key Rules

1. **Supabase is source of truth** - Always use RPCs or direct SQL via Supabase MCP for status changes
2. **All item details live in Supabase** - Store details in `pm_backlog_items.body` / `pm_comments`; do NOT create BACKLOG-XXX.md files (`items/` is read-only archive)
3. **Database constraints enforce schema** - Supabase enforces valid status values, types, and priorities via enums and constraints
4. **Log key changes** - Changes are automatically tracked in `pm_changelog` table
5. **Legacy CSV column order (archive reference)** - `id,title,type,area,priority,status,sprint,est_tokens,actual_tokens,variance,created_at,completed_at,file,description`

### Legacy CSV Column Order (Archive Reference)

```
id,title,type,area,priority,status,sprint,est_tokens,actual_tokens,variance,created_at,completed_at,file,description
```

> **Note:** The CSV uses different status format (Title Case: `In Progress`) while Supabase uses underscore format (`in_progress`). When querying Supabase, use the underscore format.

---

## Status Flow (IMPORTANT)

```
pending → in_progress → testing → completed
                           ↓
                       reopened → in_progress → ...
```

**Supabase status values (underscore format):**
- `pending` - Not started
- `in_progress` - Currently being worked on
- `testing` - Code merged, awaiting user verification
- `completed` - Done AND verified by user
- `blocked` - Waiting on something
- `deferred` - Postponed
- `obsolete` - No longer relevant
- `reopened` - Failed testing, needs more work

**CRITICAL RULES:**
1. Code merged = `testing` (NOT completed)
2. Only user verification = `completed`
3. Failed testing = `reopened` (NEVER create new task)

### Priority
- `critical` - Must be done immediately
- `high` - Important, do soon
- `medium` - Normal priority
- `low` - Nice to have

---

## Related Documentation

- Schema details: `.claude/plans/backlog/data/SCHEMA.md`
- Estimation guidelines: [estimation-guidelines.md](estimation-guidelines.md)
- CSV reference (archive): [csv-reference.md](csv-reference.md)
