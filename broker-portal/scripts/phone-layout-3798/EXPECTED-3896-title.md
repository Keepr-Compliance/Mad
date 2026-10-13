# BACKLOG-3896 fix-up (title in top bar) harness expectations — written before the run

Base = 84d0ff22f (the PR head before this change). Branch = this change. New dumps
`title-users / -support / -mytx / -dashboard / -detail / -submissions` (shell at a
real route path + real PageHeader with the props that page passes), run unchanged on
both sides (phone-only props are spread from an untyped object).

## 768 / 1024 / 1280
`compare.cjs base branch 768 1024 1280`: IDENTICAL for every dump, old and new. No exceptions.

## 375 / 640 — old dumps (shell-*, support-dialog, users-*, user-details, messages, attachments, checklist, submissions-list)
IDENTICAL (they run at /dashboard/submissions/... or render components this change does not touch).

## 375 / 640 — new dumps
- title-submissions: IDENTICAL (wordmark top bar, visible h1).
- title-detail (users/[id]): only the top bar changes (HEADER key text becomes the
  generic title "User"); h1 and everything below unchanged in size and position.
- title-users, title-dashboard: HEADER key text becomes the page title; H1 rect shrinks
  to about 1x1 (sr-only); the subtitle P is display:none (row gone); the Body P / button
  move up by the whole header block (h1 + subtitle + 24px gap, about 80px). HEADER rect
  height itself unchanged (56px + safe area).
- title-support: as above, but the New Ticket button row stays (button present, same
  size), the H1 shrinks to 1x1, subtitle gone; the 24px gap stays, so Body moves up by
  about the subtitle block only (the row height is kept by the button).
- title-mytx: HEADER key text changes; H1 shrinks to 1x1; the subtitle P ("3 submissions")
  stays visible and keeps its 24px gap; Body moves up by about the h1 height (32px).
Anything else (an A:/BUTTON: row other than the above, a width change, any row at >= 768) fails.

# BACKLOG-3904 fix-up (submissions title in top bar) — written before the run

Base = 01abfcd9f (3904 merged with 3896, before this change). Branch = this change.
Harness change (same on both sides): `title-submissions` now renders the real PageHeader
with the props the page passes (phone-only props spread from PH; className max-md:mb-3);
new `title-submission-detail` (h1 = property address, as on the detail page).

## 768 / 1024 / 1280
IDENTICAL for every dump. No exceptions.

## 375 / 640
- title-submissions: HEADER key text becomes "Submissions"; H1 shrinks to ~1x1 (sr-only);
  subtitle P display:none; Body moves up by the h1 + subtitle block (gap becomes 12px
  from max-md:mb-3, was 24px default overridden to 12px by className); no other change.
- title-submission-detail: only the top bar changes (HEADER key text becomes "Submission");
  h1 and everything below unchanged.
- shell-* and any other dump whose mockPath is the default /dashboard/submissions/sub-1:
  only HEADER key text changes (wordmark -> "Submission"). Nothing else moves.
- submissions-list (real SubmissionsPage, no shell): H1 shrinks to ~1x1, subtitle gone,
  everything below moves up by the header block. Nothing else.
Anything else fails.
