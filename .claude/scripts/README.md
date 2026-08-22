# `.claude/scripts/`

Small operator tools for the agent workflow. Not shipped with the app, not
imported by `src/` or `electron/` — these are run by hand or by an agent.

| Script | What it does |
|---|---|
| `build-line.py` | Renders a dependency-graph artifact page from tracker data (BACKLOG-2777). See below. |
| `convert-tokens-to-csv.js` | Converts `.claude/metrics/tokens.jsonl` to `tokens.csv`. |
| `show-token-metrics.sh` | Prints a token-usage summary from `.claude/metrics/tokens.csv`. |

The `.js` files here are linted by `npm run lint` (BACKLOG-2777 widened it to
`eslint electron src scripts .claude/scripts`). `build-line.py` is Python and is
not covered by eslint.

---

## `build-line.py` — the dependency graph renders itself

The founder asked, on 2026-08-21: *"is there a way to create this graph by a
component of the project plan so we don't have to generate it every time?"*

This is that component. Every regeneration reads `pm_backlog_items` and
`pm_dependencies`, so the picture cannot quietly disagree with the tracker the
way a hand-drawn one does. Publish the output to the **same** artifact URL every
time — the founder keeps one stable link instead of a new one per run.

### Usage

```bash
python3 .claude/scripts/build-line.py <config.json> <snapshot.json> [prev-snapshot.json] > out.html
```

Pass `prev-snapshot.json` (the snapshot from the last run) and the page gains a
**Before** chart and a **What changed** list — added items, removed items, and
every status transition. That diff is the part the founder reads first, so keep
the previous snapshot around between runs.

### Step 1 — pull the snapshot

Run this through the Supabase MCP `execute_sql` tool and save the single
returned JSON object as `snapshot.json`. `$ids` is the list of `legacy_id`s in
your config's `nodes` — the query is deliberately scoped to them, so an unrelated
backlog item can never wander into the graph.

```sql
SELECT json_build_object(
  'items', (SELECT json_agg(json_build_object(
              'id', i.legacy_id, 'status', i.status, 'priority', i.priority))
            FROM pm_backlog_items i WHERE i.legacy_id = ANY($ids)),
  'deps',  (SELECT json_agg(json_build_object('src', s.legacy_id, 'tgt', t.legacy_id))
            FROM pm_dependencies d
            JOIN pm_backlog_items s ON s.id = d.source_id
            JOIN pm_backlog_items t ON t.id = d.target_id
            WHERE s.legacy_id = ANY($ids) AND t.legacy_id = ANY($ids)));
```

`pm_*` RPCs reject MCP sessions (`internal_roles` guard), but direct SQL on the
`pm_*` tables works — which is what this query is.

### Step 2 — write the config

Copy `build-line-config.example.json` and edit it. The split is the point:

**Derived from the tracker — never hand-edited**

- node color and label suffix, from `pm_backlog_items.status`:

  | status | class | label suffix |
  |---|---|---|
  | `completed` | green | ` ✓` |
  | `in_progress` | blue | `— in progress` |
  | `testing` | blue | `— in QA` |
  | `pending_uat` | purple | `— awaiting your test` |
  | `waiting_for_user` | purple | `— waiting on founder` |
  | `deferred` | amber, dashed | `— deferred` |
  | `obsolete` | grey | *(none)* |
  | `pending` | neutral | *(none)* |
  | **anything else** | **red, 2px** | **`— ⚠ UNKNOWN STATUS: <status>`** |

  Every status the tracker can hold is mapped **explicitly**, including
  `pending` — so a node rendering as plain pending is always a decision, never a
  miss. The map used to fall back to pending for anything unlisted, which meant
  `deferred` (70 items) and `waiting_for_user` (8) came out byte-identical to
  pending: "we decided not to do this" and "blocked on the founder" both read as
  "not started yet". **If the tracker gains a status, this page goes red rather
  than quiet** — that red node means the generator needs updating, not that the
  work is in trouble. Add the status to `STATUS_CLS`/`SUFFIX` in `build-line.py`
  and to the legend.
- solid arrows, from `pm_dependencies`, drawn prerequisite → dependent
- the **What changed** list, when a previous snapshot is passed

**Judgment, so it lives in the config**

- `nodes[id].label` — the short human name. A founder reads
  "Disk-space guard", not "BACKLOG-2743".
- `nodes[id].cls` — an override, e.g. `"park"` for something deliberately set
  aside; a parked node is drawn dashed and labelled "parked" regardless of status
- `dashed_edges` — `[from, to, "optional label"]`. A sequencing *choice*
  ("this should land first"), not a recorded dependency. A dashed edge that
  duplicates a real dependency is dropped automatically, so the solid arrow wins.
- `title` / `eyebrow` / `sub` / `notes` — the prose around the chart

An id in `nodes` that the snapshot does not contain is skipped, so a stale
config degrades to a smaller graph rather than a crash.

### Step 3 — publish

The output is a self-contained page: inline CSS, light/dark aware, and a
`<pre class="mermaid">` block that artifact pages render natively — no external
scripts, which is required because artifacts cannot reach any external host.

### Not doing: a fully self-updating page

A page that fetches live data when opened would need a Supabase edge function
plus an auth story, because the `pm_*` tables are internal-role-guarded and an
artifact page cannot call an external host. One command regenerating the page is
cheaper than that, so this stays a generator. File it separately if the founder
ever asks.
