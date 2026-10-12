/**
 * The billing go-live flag — BACKLOG-3844 (plan v3 §1 D7).
 *
 * One server-side switch for the whole billing surface: the page today, the
 * checkout and webhook slices later. ON only when `BILLING_ENABLED` is exactly
 * the string `'true'`; unset, `'false'`, `'1'`, `'TRUE'` and anything else are
 * OFF, so a missing variable can never open billing.
 *
 * SERVER ONLY. Never a `NEXT_PUBLIC_` variable and never imported by a
 * `'use client'` module: a public value is inlined at build time, and client
 * code would read `undefined` here. Client components receive a boolean prop
 * that the server computed.
 *
 * Read on every call, never memoised in a module constant: the value is
 * process configuration, and changing it on Vercel takes a redeploy anyway.
 */
export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === 'true';
}
