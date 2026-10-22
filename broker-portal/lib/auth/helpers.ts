/**
 * Shared Auth Helpers
 *
 * Utilities for extracting user information from Supabase Auth user objects.
 * Used by both /auth/callback and /auth/setup/callback routes.
 */

import type { User } from '@supabase/supabase-js';

/**
 * Check if a string looks like a valid email address.
 * Rejects Microsoft #EXT# guest UPN formats.
 */
function isValidEmail(value: string): boolean {
  return value.includes('@') && !value.includes('#EXT#');
}

/**
 * Extract email from Supabase user with fallback chain for Microsoft Azure AD.
 *
 * Microsoft may not return email in the ID token for external/guest tenants.
 * This chain tries multiple locations where the email might be stored:
 *
 * 1. user.email (from auth.users, populated by Supabase from ID token)
 * 2. user_metadata.email (from Microsoft profile)
 * 3. user_metadata.mail (Microsoft mail property)
 * 4. user_metadata.preferred_username (UPN, only if valid email format)
 * 5. custom_claims.upn (User Principal Name, only if valid email format)
 */
export function extractEmail(user: User): string | null {
  if (user.email) return user.email.toLowerCase();

  const meta = user.user_metadata;
  if (!meta) return null;

  if (typeof meta.email === 'string' && meta.email) {
    return meta.email.toLowerCase();
  }

  if (typeof meta.mail === 'string' && meta.mail) {
    return meta.mail.toLowerCase();
  }

  if (typeof meta.preferred_username === 'string' && isValidEmail(meta.preferred_username)) {
    return meta.preferred_username.toLowerCase();
  }

  const customClaims = meta.custom_claims as Record<string, unknown> | undefined;
  if (customClaims && typeof customClaims.upn === 'string' && isValidEmail(customClaims.upn)) {
    return customClaims.upn.toLowerCase();
  }

  return null;
}
