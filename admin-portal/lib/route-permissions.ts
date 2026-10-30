/**
 * Route-level permission map for the admin portal middleware.
 *
 * Maps route prefixes to the permission keys that grant access (any one is
 * enough). The first prefix that matches wins, so list longer prefixes before
 * shorter ones that share a start.
 */

export const ROUTE_PERMISSIONS: Record<string, string[]> = {
  // BACKLOG-4005: Reports, Analytics overview and Funnel all live here.
  '/dashboard/reports': ['analytics.view'],
  '/dashboard/users': ['users.view'],
  '/dashboard/organizations': ['organizations.view'],
  '/dashboard/audit-log': ['audit.view'],
  '/dashboard/settings': ['internal_users.view', 'roles.view', 'audit.view'],
  '/dashboard/support': ['support.view'],
};

/** Permission keys required for `pathname`, or null when no prefix gates it. */
export function requiredPermissionsFor(pathname: string): string[] | null {
  for (const [routePrefix, requiredPermissions] of Object.entries(ROUTE_PERMISSIONS)) {
    if (pathname.startsWith(routePrefix)) return requiredPermissions;
  }
  return null;
}
