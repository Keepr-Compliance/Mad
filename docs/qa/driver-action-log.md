# QA driver action logging (BACKLOG-1969)

The reliable QA driver (`e2e/driver/`, run via `npm run qa:drive`) logs **every hover / press / fill**
so a run is **self-verifiable**: you can see, side by side, what the driver *intended* to do and what
the DOM *actually* received — and diff the two.

There are two streams, both single-line and greppable:

## 1. INTENT — what the driver meant to do

Emitted by the driver **before** it performs an action, with the resolved element's visible text:

```
[driver-action] <HH:MM:SS.mmm> <verb> testid=<testid|selector> text="<resolved innerText>"
```

Example:

```
[driver-action] 14:03:09.512 press testid=nav-new-audit text="New Audit"
[driver-action] 14:03:10.087 press testid=address-filter-toggle text="Filter by property address"
[driver-action] 14:03:11.200 fill testid=input[type=date]:start text="2026-01-01"
```

- **verb** — one of `hover`, `press`, `fill`.
- **testid=** — the `data-testid` the driver targeted. When an element has no testid, the field
  carries the fallback selector the driver used instead (e.g. `data-action=skip`,
  `role=button:Export`, `role=heading:742 Birchwood Lane`).
- **text=** — the element's visible innerText (whitespace-collapsed, truncated to 60 chars). For a
  `fill`, this is the value being typed.

## 2. REALITY — what the DOM actually received

An init-script installed in the renderer (`page.addInitScript`) adds **capture-phase** listeners for
`pointerover`, `mousedown`, and `click` on interactive elements (`[data-testid]`, `button`,
`[role=button]`, `a`). Each real event logs one line to the renderer console, which the driver
captures (`page.on('console')`) and re-emits to its own log verbatim:

```
[dom-event] <type> testid=<testid|selector> text="<innerText>"
```

Example:

```
[dom-event] pointerover testid=nav-new-audit text="New Audit"
[dom-event] mousedown testid=nav-new-audit text="New Audit"
[dom-event] click testid=nav-new-audit text="New Audit"
```

- **type** — the real DOM event (`pointerover` | `mousedown` | `click`).
- **testid=** — the nearest interactive ancestor's `data-testid` (so a click on a `<span>` inside a
  `<button>` reports the button). Falls back to `role=<role>` or `tag=<tag>` when no testid exists.
- **text=** — the element's innerText / textContent / aria-label (same truncation as intent).

## Diffing intent vs reality

Because the two prefixes interleave in one stream, verification is a grep:

```bash
npm run qa:drive 2>&1 | grep -E '^\[driver-action\]|^\[dom-event\]'
```

Read it top-to-bottom: each `[driver-action] press testid=X` should be immediately followed by
`[dom-event] click testid=X` on the **same** `testid=` / `text=` tail. A mismatch — the driver
pressed `X` but the DOM delivered the click to `Y` — is immediately visible:

```
[driver-action] 14:03:09.512 press testid=nav-new-audit  text="New Audit"   ← intent
[dom-event]      click        testid=nav-clients-contacts text="Clients"     ← reality (MISMATCH!)
```

To isolate one testid:

```bash
npm run qa:drive 2>&1 | grep -E 'testid=nav-new-audit'
```

## Enabling / disabling

Action logging is **ON by default** for driver runs. To silence it, set the env flag to a falsy
value:

```bash
KEEPR_QA_ACTION_LOG=0 npm run qa:drive     # also accepts: false / off / no (any case)
```

When disabled, the logger is a complete no-op (no init-script install, no console listener, no
output) — zero cost.

## Where it lives

| Concern | File |
| --- | --- |
| Line formatters, `ActionLogger`, env gating, DOM capture init-script | `e2e/driver/actionLog.ts` |
| Intent hooks on every action + init-script / console wiring | `e2e/driver/appDriver.ts` |
| Unit proofs of the line formats + capture | `e2e/driver/__tests__/actionLog.test.ts` |

## Scope

This is **additive observability only**. It does not change any assertion logic or the
PASS / FAIL / HARNESS_ERROR outcome classification (`e2e/driver/outcome.ts`).
