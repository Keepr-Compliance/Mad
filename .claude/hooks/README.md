# Metrics hooks — how an agent's spend gets attributed

The contract changed in BACKLOG-1693. If you write PM tooling, read the first section.

## Task identity is bound to `agent_id`, not to a shared file

`.claude/.current-task` used to be the source of truth: the PM wrote it, then spawned an
agent, and `SubagentStop` read it back. One file, every concurrent agent. Measured on
2026-08-11 — five consecutive agents were all recorded against BACKLOG-2617 while the file
already read BACKLOG-2628; one item had accumulated 262 runs and 104M tokens over nine days;
19.2% of labelled rows were recorded outside their item's lifetime; 8.8% of completed items
had any attributable metric at all.

Identity is now written **per agent, at spawn**:

```
register-agent.sh  (PostToolUse: Agent|Task)
  └─ ~/.claude/agent-tasks/<agent_id>.json   {legacy_id, agent_type, description, …}

track-agent-tokens.sh  (SubagentStop)
  └─ reads that file by its own agent_id, then writes pm_token_metrics
```

Resolution order at stop, first hit wins:

| # | Source | Covers |
|---|--------|--------|
| 1 | sidecar `~/.claude/agent-tasks/<agent_id>.json` | the normal path |
| 2 | first `BACKLOG-nnnn` in the agent's own brief, read from its transcript | foreground `Agent` calls, where `PostToolUse` fires *after* `SubagentStop` and no sidecar exists yet |
| 3 | `pm_agent_activity` row for that `agent_id` | sidecar lost (different machine, pruned) |
| 4 | `.claude/.current-task` — **only** when no sibling subagent is running **and** the file's mtime falls inside this run's window | single-agent sessions using the old convention |
| 5 | nothing — the row is written unlabelled | anything else |

Step 5 is deliberate. An unlabelled row is recoverable later; a wrongly-labelled one corrupts
every figure derived from it and nobody finds out.

`.current-task` still works for the case it was designed for, and is ignored the moment it
cannot be trusted. **PM agents may keep writing it, but it is no longer how an agent is
identified** — spawn the agent with its `BACKLOG-nnnn` in the brief and identity follows
automatically.

## What each hook writes

| Hook | Event | Writes |
|---|---|---|
| `register-agent.sh` | `PostToolUse: Agent\|Task` | sidecar + `pm_agent_activity` row |
| `agent-heartbeat.sh` | `PostToolUse: Edit\|Write` | refreshes `pm_agent_activity`, detects files actually touched |
| `track-agent-tokens.sh` | `SubagentStop` | one `pm_token_metrics` row per subagent run |
| `track-main-session.sh` | `Stop` | one `pm_token_metrics` row per main-session turn (`agent_type = 'main'`) |
| `agent-identity.sh` | — | shared helpers, sourced by both metric hooks |

Main-session rows are **deltas**. The session transcript is cumulative, so re-summing it every
turn would multiply a session's cost by its turn count; the hook keeps a line offset per
session in `~/.claude/metrics/main-offsets/` and reads only what is new. `agent_id` is
`main:<session_id>:<line offset>`, which makes a repeat fire a no-op under the RPC's
`ON CONFLICT (agent_id, session_id) DO NOTHING`.

## Columns worth knowing

- **`billable_tokens`** = input + output + cache_create. Use this. `total_tokens` includes
  `cache_read` and runs ~19x higher.
- **`backlog_item_id`** is a uuid and passes a regex gate before it is sent. This is not
  cosmetic: the RPC parameter is uuid-typed, so a text label there is a 400 and the **entire
  row is lost**, not mislabelled.
- **`model`** is the modal model over the run, excluding `<synthetic>` and excluding entries
  whose model equals `advisorModel` — the advisor runs a different model inside the same
  session, and "first entry with a model" names it instead of the worker.
- **`cost_usd` is null on purpose.** No transcript carries a cost field (checked in both
  subagent and main-session shapes), so the hook would have to hardcode a rate table, and the
  long-context (`[1m]`) premium is invisible in the transcript anyway. The inputs are all
  recorded, so a rate table can backfill it whenever rates live somewhere authoritative.

Advisor tokens **are** counted in the sums. They are real spend; the exclusion above only
decides which model gets named.

## Failure behaviour

Every one of these is non-blocking and exits 0 — a metrics outage must never stop an agent.
Failed RPC payloads are parked in `~/.claude/metrics/failed-payloads.jsonl` for replay, and
bypasses are visible afterwards through the `pm_agent_bypassed` view.

## Verifying a change

```bash
.claude/hooks/tests/verify-attribution.sh
```

Runs the real scripts against real transcripts and the real RPC, then reads the rows back.
Every check breaks something first and confirms it goes red. Test rows are prefixed
`test-1693-` and deleted at the end.

**Claude Code loads hooks from the session's own project dir, so a worktree copy is inert.**
Passing here is not evidence the harness fires them — re-run after deploying, and confirm a
row appears for a real agent.
