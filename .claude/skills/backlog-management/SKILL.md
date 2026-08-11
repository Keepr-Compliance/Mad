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

---

## Linking a New Item (MANDATORY)

Every field below already exists in the schema. The gap has been discipline, not tooling:
`introduced_by` was used 12 times on 2026-03-31 and then not once for four months, while the
work that would have used it kept happening.

### 1. Filing a bug you found while working another item → `introduced_by`

**Source is the NEW item. Target is the work that produced it.** Read it as a sentence:
*"2634 was introduced by 2619."*

Run this in the same step as the `INSERT` — not later, not "when I get a chance":

```sql
INSERT INTO pm_task_links (source_id, target_id, link_type)
SELECT n.id, o.id, 'introduced_by'
FROM pm_backlog_items n, pm_backlog_items o
WHERE n.legacy_id = 'BACKLOG-<new>' AND o.legacy_id = 'BACKLOG-<originator>'
ON CONFLICT (source_id, target_id, link_type) DO NOTHING
RETURNING source_id, target_id;
```

`ON CONFLICT` is safe because `pm_task_links` is `UNIQUE (source_id, target_id, link_type)`.
No `RETURNING` row means the link already existed — that is fine, but a silent zero rows also
means one of your `legacy_id` values did not match, so check which.

**Worked examples — all seven are live rows you can query right now:**

| New item (source) | `introduced_by` (target) | What produced it |
|---|---|---|
| BACKLOG-2634 the duplicate badge counts pairs, not questions | BACKLOG-2619 | linker name-check work |
| BACKLOG-2635 phone stored without a country code never matches | BACKLOG-2619 | linker name-check work |
| BACKLOG-2636 a removed contact is still a link candidate | BACKLOG-2620 | linker-convergence work |
| BACKLOG-2637 a source file with a raw NUL reads as binary | BACKLOG-2620 | linker-convergence work |
| BACKLOG-2631 merging a duplicate leaves the old row on screen | BACKLOG-2629 | manual link/unlink refresh investigation |
| BACKLOG-2632 SQLite dates carry no timezone, evening work shows tomorrow | BACKLOG-2629 | manual link/unlink refresh investigation |
| BACKLOG-2633 the picker walks the whole mailbox per record | BACKLOG-2629 | manual link/unlink refresh investigation |

Verify your own link the same way:

```sql
SELECT s.legacy_id AS new_item, t.legacy_id AS introduced_by
FROM pm_task_links l
JOIN pm_backlog_items s ON s.id = l.source_id
JOIN pm_backlog_items t ON t.id = l.target_id
WHERE l.link_type = 'introduced_by' AND s.legacy_id = 'BACKLOG-<new>';
```

**Do not rely on prose.** Writing "found while working BACKLOG-2619" in the body is not a link.
Measured across the seven above: six mention a discovery phrase, only five name their true
originator, and none name it uniquely. 2632 references nothing at all and 2633 names two
unrelated items. Prose is a lead; the link is the record.

### 2. Planned order vs hard dependency — keep them separate

These are two different facts and they live in two different places.

| Fact | Where it goes | Meaning |
|---|---|---|
| "We intend to do these in this order" | `pm_backlog_items.sort_order` | A choice. Reorder it freely. |
| "B cannot start until A lands" | `pm_dependencies` (`depends_on`) | A constraint. Reordering breaks the work. |

**Why conflating them destroys the graph:** if every plan-order step also becomes a dependency,
then everything is blocked by everything, every item shows as blocked, and the two or three
constraints that are actually real become invisible in the noise. The graph stops answering the
only question it exists to answer — *what can I start right now?*

Set intended order with `sort_order` (integer, `NOT NULL`, defaults 0; leave 0 for unsequenced
work and use gaps of 10 so items can be inserted later):

```sql
UPDATE pm_backlog_items SET sort_order = 30, updated_at = now()
WHERE legacy_id = 'BACKLOG-2633' RETURNING legacy_id, sort_order;
```

Record a hard dependency only when reordering would genuinely break something:

```sql
INSERT INTO pm_dependencies (source_id, target_id, dependency_type)
SELECT b.id, a.id, 'depends_on'          -- b depends on a; a must land first
FROM pm_backlog_items b, pm_backlog_items a
WHERE b.legacy_id = 'BACKLOG-2631' AND a.legacy_id = 'BACKLOG-2633'
ON CONFLICT (source_id, target_id) DO NOTHING
RETURNING source_id, target_id;
```

**Worked example — the live contacts sequence.** Plan order is 2617 → 2471 → 2633 → 2631 → 2609
(`sort_order` 10, 20, 30, 40, 50). Only two of those four steps are real constraints:

| Pair | Kind | Why |
|---|---|---|
| 2631 **depends on** 2633 | hard | A mount guard in the picker conceals the slow query. Fix the guard first and the slow query stops being observable — you cannot verify 2631 until 2633 lands. |
| 2609 **depends on** 2633 | hard | Migrations serialise. |
| 2617 **precedes** 2471 | plan order only | A choice about what to tackle first. **No `pm_dependencies` row exists for this pair, and none should.** |

The test to apply: *if I swapped these two, would the work break, or would I just be annoyed?*
Breaks → `pm_dependencies`. Annoyed → `sort_order`.

### 3. `area` — use the controlled vocabulary

Pick from values already in use; do not invent a spelling. Check before you write:

```sql
SELECT area, count(*) FROM pm_backlog_items
WHERE deleted_at IS NULL AND area IS NOT NULL GROUP BY area ORDER BY count(*) DESC;
```

Duplicate spellings were merged on 2026-08-10 (85 distinct values → 77). Use the surviving form:

| Use | Not |
|---|---|
| `ui` | `UI` |
| `electron` | `electron-app` |
| `infra` | `infrastructure` |
| `desktop` | `desktop-app` |
| `database` | `db` |
| `testing` | `tests` |
| `ci` | `ci-cd` |
| `docs` | `documentation` |

A near-miss spelling is worse than leaving `area` NULL: it splits a group silently and nothing
ever reports the split. 559 of 2,450 live items have no `area` — if you know it, set it.

### 4. `type` is already reliable — leave it alone

Zero nulls across all 2,450 live items. It is the one grouping field that works today. Keep
setting it on creation (`bug` / `feature` / `chore` / `improvement` / `spike`); nothing else needed.

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
5. **Link a spawned item when you file it** - A bug found while working another item gets a `pm_task_links` row with `link_type = 'introduced_by'` in the same step as the `INSERT`. Plan order goes in `sort_order`; only genuine constraints go in `pm_dependencies`. See [Linking a New Item](#linking-a-new-item-mandatory)
6. **Legacy CSV column order (archive reference)** - `id,title,type,area,priority,status,sprint,est_tokens,actual_tokens,variance,created_at,completed_at,file,description`

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
