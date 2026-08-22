#!/usr/bin/env python3
"""Render a dependency-graph artifact page from tracker data (BACKLOG-2777).

The founder asked: "is there a way to create this graph by a component of the
project plan so we don't have to generate it every time?" This is that
component. The graph is DERIVED from pm_backlog_items + pm_dependencies, so it
cannot drift from the tracker the way a hand-drawn one does.

  python3 .claude/scripts/build-line.py config.json snapshot.json \
      [prev-snapshot.json] > out.html

Then publish out.html to the SAME artifact URL each time, so the founder keeps
one stable link rather than a new one per regeneration.

WHAT COMES FROM THE TRACKER (never hand-edited)
  - node color, from pm_backlog_items.status
  - solid edges, from pm_dependencies (drawn prerequisite -> dependent)
  - the "What changed" list (added / removed / status-changed), when a previous
    snapshot is passed as the third argument

WHAT LIVES IN THE CONFIG (judgment, not data)
  - the short human label per node (a founder-readable name, not a number)
  - "cls" overrides, e.g. "park" for an item deliberately set aside
  - dashed sequencing edges: "A should land before B" as a choice, not a
    recorded dependency
  - the title/eyebrow/sub prose and any amber notes

See build-line-config.example.json for a real config, and README.md in this
directory for the snapshot SQL.

SNAPSHOT SQL — run via the Supabase MCP execute_sql tool; $ids is the config's
node id list (kept here as well as in the README so the file is self-contained):

  SELECT json_build_object(
    'items', (SELECT json_agg(json_build_object(
                'id', i.legacy_id, 'status', i.status, 'priority', i.priority))
              FROM pm_backlog_items i WHERE i.legacy_id = ANY($ids)),
    'deps',  (SELECT json_agg(json_build_object('src', s.legacy_id, 'tgt', t.legacy_id))
              FROM pm_dependencies d
              JOIN pm_backlog_items s ON s.id = d.source_id
              JOIN pm_backlog_items t ON t.id = d.target_id
              WHERE s.legacy_id = ANY($ids) AND t.legacy_id = ANY($ids)));

Keep the previous snapshot.json around: passing it as argv[3] is what produces
the before/after diff the founder reads first.
"""
import json, sys, html

# EVERY status the tracker can hold must appear here. The map used to fall back
# to "pend" for anything unlisted, which meant `deferred` (70 items today) and
# `waiting_for_user` (8) rendered BYTE-IDENTICAL to `pending`: "we decided not to
# do this" and "blocked on the founder" both read as "not started yet". That is
# the one failure this page is supposed to be incapable of — it exists so the
# picture cannot quietly disagree with the tracker.
#
# `pending` is listed EXPLICITLY rather than left to a default, so that a status
# rendering as plain pending is always a decision someone made, never a miss.
STATUS_CLS = {
    "completed": "done",
    "in_progress": "prog",
    "testing": "prog",
    "pending_uat": "uat",
    "waiting_for_user": "uat",
    "deferred": "defer",
    "obsolete": "obso",
    "pending": "pend",
}
SUFFIX = {
    "completed": " ✓",
    "in_progress": " — in progress",
    "testing": " — in QA",
    "pending_uat": " — awaiting your test",
    "waiting_for_user": " — waiting on founder",
    "deferred": " — deferred",
}

def load(p):
    with open(p) as f:
        return json.load(f)

def mermaid(cfg, snap):
    status = {i["id"]: i["status"] for i in snap["items"]}
    ids = [i for i in cfg["nodes"] if i in status]
    lines = ["flowchart LR"]
    for i in ids:
        n = cfg["nodes"][i]
        st = status[i]
        known = st in STATUS_CLS
        # An unmapped status is a DATA condition the reader has to see, so the
        # loud class wins even over an explicit `cls` override: a config override
        # is judgment about presentation, and this is not a presentation question.
        cls = STATUS_CLS[st] if known else "unk"
        if known and n.get("cls"):
            cls = n["cls"]
        label = n["label"]
        if n.get("cls") == "park":
            label += " — parked"
        elif known:
            label += SUFFIX.get(st, "")
        if not known:
            # Quote-stripped: the status comes from the DB and is interpolated
            # into a mermaid label, where a stray `"` would break the diagram.
            label += ' — ⚠ UNKNOWN STATUS: ' + str(st).replace('"', "'")
        lines.append(f'  n{i[8:]}["{label}"]:::{cls}')
    drawn = set()
    for d in snap["deps"]:
        s, t = d["src"], d["tgt"]
        if s in cfg["nodes"] and t in cfg["nodes"] and s in status and t in status:
            lines.append(f"  n{t[8:]} --> n{s[8:]}")  # prerequisite -> dependent
            drawn.add((t, s))
    for e in cfg.get("dashed_edges", []):
        s, t, lab = e[0], e[1], (e[2] if len(e) > 2 else "")
        if (s, t) in drawn or s not in status or t not in status:
            continue
        mid = f'-.->|"{lab}"|' if lab else "-.->"
        lines.append(f"  n{s[8:]} {mid} n{t[8:]}")
    lines += [
        "  classDef done fill:#d3f2d9,stroke:#1a7f37,color:#111;",
        "  classDef prog fill:#cfe3f7,stroke:#1a5fa8,color:#111;",
        "  classDef pend fill:#eef0f4,stroke:#6e7b8a,color:#111;",
        "  classDef park fill:#f2f2f0,stroke:#a0a0a0,stroke-dasharray:4 3,color:#555;",
        "  classDef uat fill:#e8d9f5,stroke:#6b3fa0,color:#111;",
        "  classDef obso fill:#ececec,stroke:#b0b0b0,color:#888;",
        # amber, so a deferred item cannot be mistaken for pending (neutral-grey)
        # or obsolete (flat grey) at a glance.
        "  classDef defer fill:#fdf0dd,stroke:#9a6700,stroke-dasharray:5 3,color:#5b4300;",
        # red, 2px: the generator failed to map this status. Not a state of the
        # work — a state of THIS SCRIPT, and it must be impossible to miss.
        "  classDef unk fill:#fde7e7,stroke:#c62828,stroke-width:2px,color:#7a1414;",
    ]
    return "\n".join(lines)

def changes(cfg, snap, prev):
    if not prev:
        return []
    old = {i["id"]: i["status"] for i in prev["items"]}
    new = {i["id"]: i["status"] for i in snap["items"]}
    lab = lambda i: cfg["nodes"].get(i, {}).get("label", i)
    out = []
    for i in new:
        if i not in old:
            out.append(f"<strong>Added</strong> — {html.escape(lab(i))} ({new[i]})")
    for i in old:
        if i not in new:
            out.append(f"<strong>Removed</strong> — {html.escape(lab(i))}")
    for i in new:
        if i in old and old[i] != new[i]:
            out.append(f"<strong>{html.escape(lab(i))}</strong> — {old[i]} → {new[i]}")
    return out

CSS = """  :root { --bg:#f7f8f6; --surface:#ffffff; --ink:#1d2b23; --muted:#5b6b60; --line:#d9dfd9; --amber:#9a6700; --amber-bg:#fff3d1; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#151a17; --surface:#1e2420; --ink:#e6ebe7; --muted:#9fb0a5; --line:#35403a; --amber:#e3b341; --amber-bg:#3a2f14; } }
  :root[data-theme="dark"] { --bg:#151a17; --surface:#1e2420; --ink:#e6ebe7; --muted:#9fb0a5; --line:#35403a; --amber:#e3b341; --amber-bg:#3a2f14; }
  body { background:var(--bg); color:var(--ink); font:16px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif; margin:0; padding:2rem 1.25rem 4rem; }
  main { max-width:960px; margin:0 auto; }
  .eyebrow { font-size:.78rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:0 0 .35rem; }
  h1 { font-size:1.65rem; margin:0 0 .3rem; text-wrap:balance; }
  .sub { color:var(--muted); margin:0 0 2rem; max-width:62ch; }
  h2 { font-size:1.05rem; margin:2.4rem 0 .6rem; padding-bottom:.35rem; border-bottom:1px solid var(--line); }
  .chart { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:1rem; overflow-x:auto; }
  .chart pre.mermaid { margin:0; }
  .note { background:var(--amber-bg); border-left:3px solid var(--amber); padding:.6rem .9rem; border-radius:0 6px 6px 0; margin:.9rem 0 0; font-size:.92rem; }
  ul.changes { padding-left:1.2rem; margin:.6rem 0 0; }
  ul.changes li { margin:.35rem 0; max-width:70ch; }
  .legend { display:flex; flex-wrap:wrap; gap:.5rem .9rem; margin:.8rem 0 0; font-size:.85rem; color:var(--muted); }
  .legend span { display:inline-flex; align-items:center; gap:.35rem; }
  .sw { width:.85rem; height:.85rem; border-radius:3px; display:inline-block; border:1.5px solid #999; }
  .sw.done { background:#d3f2d9; border-color:#1a7f37; } .sw.prog { background:#cfe3f7; border-color:#1a5fa8; }
  .sw.pend { background:#eef0f4; border-color:#6e7b8a; } .sw.park { background:#f2f2f0; border-color:#a0a0a0; border-style:dashed; }
  .sw.obso { background:#ececec; border-color:#b0b0b0; } .sw.uat { background:#e8d9f5; border-color:#6b3fa0; }
  .sw.defer { background:#fdf0dd; border-color:#9a6700; border-style:dashed; }
  .sw.unk { background:#fde7e7; border-color:#c62828; border-width:2px; }"""

def main():
    cfg = load(sys.argv[1]); snap = load(sys.argv[2])
    prev = load(sys.argv[3]) if len(sys.argv) > 3 else None
    parts = [f"<title>{html.escape(cfg['title'])}</title>", f"<style>\n{CSS}\n</style>", "<main>",
             f"<p class=\"eyebrow\">{html.escape(cfg['eyebrow'])}</p>", f"<h1>{html.escape(cfg['title'])}</h1>",
             f"<p class=\"sub\">{html.escape(cfg['sub'])}</p>"]
    if prev:
        parts += ["<h2>Before</h2>", '<div class="chart">', '<pre class="mermaid">', mermaid(cfg, prev), "</pre></div>"]
    parts += ["<h2>Current</h2>" if prev else "<h2>The line</h2>", '<div class="chart">', '<pre class="mermaid">', mermaid(cfg, snap), "</pre></div>"]
    ch = changes(cfg, snap, prev)
    if ch:
        parts += ["<h2>What changed</h2>", '<ul class="changes">'] + [f"<li>{c}</li>" for c in ch] + ["</ul>"]
    for n in cfg.get("notes", []):
        parts.append(f'<p class="note">{n}</p>')
    parts.append('<div class="legend"><span><i class="sw done"></i> completed</span><span><i class="sw prog"></i> in build</span>'
                 '<span><i class="sw pend"></i> pending</span><span><i class="sw uat"></i> awaiting founder test</span>'
                 '<span><i class="sw defer"></i> deferred</span><span><i class="sw park"></i> parked</span>'
                 '<span><i class="sw obso"></i> obsolete</span><span><i class="sw unk"></i> unknown status — the generator needs updating</span></div>')
    parts.append("</main>")
    print("\n".join(parts))

main()
