/**
 * What the consent page, the AI apps page and their actions read from the
 * incoming request (BACKLOG-4238): the raw Cookie header, parsed here so that
 * "exactly one binding cookie" can be applied, and whether a support-session
 * cookie is present at all.
 */

import { headers } from 'next/headers';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/constants';
import { bindingFromCookieHeader } from '@/lib/mcp/oauth/binding';

interface AccountRequest {
  /** A support-session cookie is present, whatever its value. */
  impersonating: boolean;
  /** The binding cookie value when exactly one well-formed one is present. */
  binding: string | null;
}

function hasCookieNamed(header: string, name: string): boolean {
  return header.split(';').some((part) => {
    const eq = part.indexOf('=');
    return (eq < 0 ? part : part.slice(0, eq)).trim() === name;
  });
}

function accountRequestFromCookieHeader(header: string | null | undefined): AccountRequest {
  const h = header ?? '';
  return {
    impersonating: hasCookieNamed(h, IMPERSONATION_COOKIE_NAME),
    binding: bindingFromCookieHeader(h),
  };
}

export async function readAccountRequest(): Promise<AccountRequest> {
  const h = await headers();
  return accountRequestFromCookieHeader(h.get('cookie'));
}
