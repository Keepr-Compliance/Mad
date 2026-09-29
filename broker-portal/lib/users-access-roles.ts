/**
 * The role list a Users-page/nav gate consults. BACKLOG-3541 follow-up.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM users-access.ts
 * ---------------------------------------------------------------------------
 * `users-access.ts` also exports `checkUsersPageAccess()`, which imports
 * `@/lib/supabase/server` and therefore reaches for `next/headers`. Importing
 * ANYTHING from that module — even a type, even a plain constant array — from
 * a `'use client'` component drags the whole server module into the client
 * bundle and `next build` fails. That failure is invisible to `tsc` and to
 * jest, both of which resolve the import happily; it shows up ONLY in
 * `next build`. Same hazard, same shape, as `lib/account/accountView.ts`
 * (client-safe) vs `getAccountView.ts` (server-only) — this file follows that
 * split rather than inventing a second convention.
 *
 * This file has NO imports at all, so it is safe to import from both server
 * and client components. `users-access.ts` imports and re-exports
 * `USERS_PAGE_ROLES` from here so existing call sites are unchanged.
 */

/** Roles that may view the Users list and a member's detail page. */
export const USERS_PAGE_ROLES = ['admin', 'it_admin', 'broker'] as const;
