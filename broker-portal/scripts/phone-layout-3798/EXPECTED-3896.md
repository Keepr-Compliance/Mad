# BACKLOG-3896 harness expectations (written before the run)

Harness: the whole-body shell dumps in `dumps.harness.tsx`, run unchanged on both
sides. Base = int-portal/release-2.41 @ c63b9698d plus this harness commit; branch =
the kit MobileTopBar + Drawer swap.

## 768 / 1024 / 1280 (and `HTML_STYLE=--review-bar-h:191px`)

`compare.cjs base branch 768 1024 1280` prints IDENTICAL. No exceptions.

## 375 / 640

Every dump except `shell-drawer`: IDENTICAL.

`shell-drawer`: only these differences.

1. `ASIDE:Main menu` GONE; the dialog is now a `div.fixed` named by its Title.
   The overlay wrapper and the dialog share that text, so the wrapper keys as
   `DIV:Main menuKeepr.Broker...` and the dialog as `DIV:Main menuKeepr.Broker...#2`.
   Dialog rect equals the old aside's: [0, 0, 288, 812].
2. The overlay wrapper's key renames (`DIV:Keepr.Broker...` GONE), because its
   text now starts with the sr-only Title. Rect unchanged: full viewport.
3. NEW `H2:Main menu`: the visually hidden Radix Title (sr-only, about 1x1 px).
4. Radix focus-guard spans: not in the measured selector, so no rows.

Anything else fails: in particular any `A:` row, `BUTTON:Close menu`, `NAV:` row,
`P:` row, `HEADER:` row, the Sign Out link, or a dialog width other than 288.

Rename rule: the drawer now sits after `main` in document order (portal at the end
of body). A row whose key changes only in its `#n` suffix, with an identical rect,
counts as a rename, not a difference.
