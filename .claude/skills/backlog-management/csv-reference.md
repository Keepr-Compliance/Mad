# Backlog Query Reference for Agents

> **⚠️ DEPRECATED:** This file was originally a CSV reference. It has been
> repurposed as a Supabase query reference, but the filename is retained
> for backward compatibility. The CSV under `.claude/plans/backlog/data/`
> is read-only archive. Source of truth is now `pm_sprints`,
> `pm_backlog_items`, `pm_comments`, `pm_token_metrics` in Supabase.

## Source of Truth

**Supabase `pm_backlog_items` table is the ONLY source of truth.** Query via MCP `execute_sql`.

The CSV files at `.claude/plans/backlog/data/` are a **legacy archive** (frozen ~BACKLOG-967). Do NOT read or write them for current data.

---

## Common Queries

### Search by keyword

```sql
SELECT item_number, title, status, priority, area
FROM pm_backlog_items
WHERE title ILIKE '%keyword%'
ORDER BY item_number;
```

### Get pending items by priority

```sql
SELECT item_number, title, type, priority, area, est_tokens
FROM pm_backlog_items
WHERE status = 'pending'
ORDER BY
  CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END;
```

### Get sprint items

```sql
SELECT i.item_number, i.title, i.status, i.priority, i.type
FROM pm_backlog_items i
WHERE i.sprint_id = '<sprint-uuid>'
ORDER BY i.item_number;
```

### Count by status

```sql
SELECT status, COUNT(*) as count
FROM pm_backlog_items
WHERE status != 'obsolete'
GROUP BY status
ORDER BY count DESC;
```

### Find duplicates before creating

```sql
SELECT item_number, title, status
FROM pm_backlog_items
WHERE title ILIKE '%invite%' OR title ILIKE '%provision%';
```

---

## Schema Quick Reference

### pm_backlog_items columns

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| item_number | int | Human-readable ID (BACKLOG-XXX) |
| title | text | Brief description |
| type | text | feature/bug/refactor/chore/test/spike/epic |
| area | text | Component area tag |
| priority | text | critical/high/medium/low |
| status | text | pending/in_progress/testing/completed/blocked/deferred/obsolete/reopened |
| sprint_id | uuid | FK to pm_sprints |
| est_tokens | int | Estimated tokens |
| actual_tokens | int | Actual tokens used |
| description | text | Full description |
| body | text | Detailed task body (for engineer consumption) |
| created_at | timestamptz | Creation date |
| completed_at | timestamptz | Completion date |

### pm_sprints columns

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Sprint name |
| status | text | planned/active/completed/cancelled |
| goal | text | Sprint goal |
| start_date | date | Start date |
| end_date | date | End date |

### pm_task_links columns

| Column | Type | Description |
|--------|------|-------------|
| source_id | uuid | FK to pm_backlog_items |
| target_id | uuid | FK to pm_backlog_items |
| link_type | text | related_to/blocks/depends_on/duplicates |
