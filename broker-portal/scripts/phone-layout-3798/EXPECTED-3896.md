# BACKLOG-3896 harness expectations (written before the run)

Harness: the whole-body shell dumps in `dumps.harness.tsx`, run unchanged on both
sides. Base = int-portal/release-2.41 @ c63b9698d plus this harness commit; branch =
the kit MobileTopBar + Drawer swap.

## 768 / 1024 / 1280 (and `HTML_STYLE=--review-bar-h:191px`)

`compare.cjs base branch 768 1024 1280` prints IDENTICAL. No exceptions.

## 375 / 640

Every dump except `shell-drawer`: IDENTICAL.

`shell-drawer`: only these differences.

1. `ASIDE:Main menu` GONE; the dialog is now a DIV named by its Title, key
   `DIV:Main menuKeepr.Broker...` NEW. Its rect equals the old aside's rect:
   left 0, top 0, width 288, bottom 812.
2. The overlay `div.fixed` key renames, because its text now starts with the
   sr-only Title ("Main menu..." instead of "Keepr.Broker..."). Rect unchanged:
   full viewport.
3. NEW `H2:Main menu`: the visually hidden Radix Title (sr-only, about 1x1 px).
4. Radix focus-guard spans: not in the measured selector, so no rows.

Anything else fails: in particular any `A:` row, `BUTTON:Close menu`, `NAV:` row,
`P:` row, `HEADER:` row, the Sign Out link, or a dialog width other than 288.
