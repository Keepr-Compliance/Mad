/**
 * User Display Utilities
 *
 * Pure utility functions for formatting and displaying user information.
 * These functions have no dependencies on external services and can be
 * used in both client and server contexts.
 *
 * TASK-1814: Initial utilities
 */

import type { Role } from '../types/users';

// ============================================================================
// Display Utilities
// ============================================================================

/**
 * Format a user's display name from various fields
 *
 * @param user - User object with name fields (can be partial or null)
 * @param fallbackEmail - Email to use if no name available
 * @returns Formatted display name
 */
export function formatUserDisplayName(
  user: {
    display_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null,
  fallbackEmail?: string | null
): string {
  if (user?.display_name) {
    return user.display_name;
  }

  const fullName = [user?.first_name, user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (fullName) {
    return fullName;
  }

  return fallbackEmail || 'Unknown User';
}

/**
 * Get initials from a user's name for avatar display
 *
 * @param user - User object with name fields
 * @param fallbackEmail - Email to use if no name available
 * @returns 1-2 character initials string
 */
export function getUserInitials(
  user: {
    display_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null,
  fallbackEmail?: string | null
): string {
  // Try display_name first
  if (user?.display_name) {
    const parts = user.display_name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  }

  // Try first_name + last_name
  if (user?.first_name && user?.last_name) {
    return (user.first_name[0] + user.last_name[0]).toUpperCase();
  }

  // Try first_name only
  if (user?.first_name) {
    return user.first_name.substring(0, 2).toUpperCase();
  }

  // Fallback to email
  if (fallbackEmail) {
    return fallbackEmail.substring(0, 2).toUpperCase();
  }

  return '??';
}

/**
 * Get a human-readable provisioning source description
 *
 * @param source - The provisioning source
 * @returns Human-readable description
 */
export function getProvisioningDescription(source: string | null): string {
  switch (source) {
    case 'manual':
      return 'Added manually';
    case 'scim':
      return 'Provisioned via SCIM';
    case 'jit':
      return 'Just-in-time provisioned';
    case 'invite':
      return 'Joined via invitation';
    default:
      return 'Unknown';
  }
}

// ============================================================================
// Role Utilities
// ============================================================================

/**
 * Get roles that can be assigned by the current user based on their role
 *
 * @param currentUserRole - The role of the user making the assignment
 * @returns Array of roles that can be assigned
 */
export function getAssignableRoles(currentUserRole: Role): Role[] {
  if (currentUserRole === 'it_admin') {
    return ['agent', 'broker', 'admin', 'it_admin'];
  }
  if (currentUserRole === 'admin') {
    return ['agent', 'broker', 'admin'];
  }
  return [];
}

/**
 * Check if a user can assign a specific role
 *
 * @param assignerRole - Role of the user making the assignment
 * @param targetRole - Role being assigned
 * @returns True if assignment is allowed
 */
export function canAssignRole(assignerRole: Role, targetRole: Role): boolean {
  const assignableRoles = getAssignableRoles(assignerRole);
  return assignableRoles.includes(targetRole);
}

// ============================================================================
// Viewer Identity — who the app chrome names (BACKLOG-3077)
// ============================================================================

/** Auth user shape the portal reads a name/email off. `user_metadata` is
 *  untrusted JSON, so its fields are `unknown` and narrowed before use. */
export interface ViewerUser {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

/** The fields of an impersonation session that identify the target user. */
export interface ViewerImpersonation {
  target_name?: string | null;
  target_email?: string | null;
}

/** Name + email of the person the sidebar and dashboard header should name. */
export interface ViewerIdentity {
  displayName?: string;
  displayEmail: string;
}

/** First argument that is a non-empty string once trimmed, else ''. */
function firstNonEmptyString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

/**
 * Resolve whose name the chrome shows.
 *
 * During impersonation this is the IMPERSONATED user, never the admin driving
 * the session: the admin is meant to see what the target user sees, and the
 * impersonation cookie is the only identity that describes them.
 */
export function resolveViewerIdentity(
  impersonation: ViewerImpersonation | null | undefined,
  user: ViewerUser | null | undefined
): ViewerIdentity {
  if (impersonation) {
    const name = firstNonEmptyString(impersonation.target_name);
    return {
      displayName: name || undefined,
      displayEmail: firstNonEmptyString(impersonation.target_email),
    };
  }

  const meta = user?.user_metadata ?? {};
  const name = firstNonEmptyString(meta.full_name, meta.name);
  return {
    displayName: name || undefined,
    displayEmail: firstNonEmptyString(user?.email),
  };
}

/**
 * The label for a viewer: their display name, else the local part of their
 * email. Returns '' when neither is usable — callers decide the fallback
 * (the sidebar shows 'User'; the dashboard header shows 'Dashboard').
 *
 * BACKLOG-3077: single resolution shared by the sidebar and the dashboard
 * header so the two can never name the same person differently.
 */
export function resolveViewerName(identity: ViewerIdentity): string {
  const name = firstNonEmptyString(identity.displayName);
  if (name) return name;
  return firstNonEmptyString(identity.displayEmail.split('@')[0]);
}

/**
 * The dashboard <h1>: "Welcome back, <first name>", falling back to the
 * generic "Dashboard" when no name is available. Never renders a greeting
 * with an empty name.
 *
 * "First name" is the first whitespace-separated token of the resolved name;
 * an email local part has no name structure, so it is used whole.
 */
export function getDashboardHeading(identity: ViewerIdentity): string {
  const firstName = resolveViewerName(identity).split(/\s+/)[0] ?? '';
  return firstName ? `Welcome back, ${firstName}` : 'Dashboard';
}
