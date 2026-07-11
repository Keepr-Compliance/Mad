# Vercel Ignored Build Step — skip verification (throwaway)

This file exists only to verify that a non-portal commit (here: docs-only)
causes **admin-portal**'s Vercel build to be **skipped (Canceled)** by the
Ignored Build Step, while **broker-portal** (ignore step not yet configured)
builds normally.

Touches none of the portal-watched paths:
`admin-portal/`, `shared/`, `packages/shared/`, `package.json`, `package-lock.json`.

Safe to delete — along with the `test/vercel-skip-check` branch.
