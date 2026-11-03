/**
 * Old admin URLs kept working after BACKLOG-4005 moved Analytics, Funnel and
 * the reports under /dashboard/reports (and BACKLOG-3721 moved Support
 * Analytics there as Support SLA). Temporary (307) on purpose: the
 * Reports area is still changing. Order matters: the specific reports rule
 * must come before the bare /dashboard/analytics rule. Next carries the
 * request query string to the destination.
 */

export const LEGACY_REDIRECTS = [
  { source: '/dashboard/analytics/reports/:path*', destination: '/dashboard/reports/:path*', permanent: false },
  { source: '/dashboard/analytics', destination: '/dashboard/reports/analytics', permanent: false },
  { source: '/dashboard/funnel', destination: '/dashboard/reports/funnel', permanent: false },
  // BACKLOG-3721: Support -> Analytics became the Support SLA report.
  { source: '/dashboard/support/analytics', destination: '/dashboard/reports/support-sla', permanent: false },
];
