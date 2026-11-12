/**
 * The browser binding cookie read from a raw Cookie header (BACKLOG-4238).
 *
 * Used by /oauth/authorize and by the consent page and its actions. A request
 * counts as bound only when it carries exactly one well-formed binding value.
 */

import { BINDING_COOKIE } from './paths';
import { isCredential } from './validate';

/** The binding cookie's value when the header carries exactly one well-formed one, else null. */
export function bindingFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === BINDING_COOKIE) values.push(part.slice(eq + 1).trim());
  }
  return values.length === 1 && isCredential('bd', values[0]) ? values[0] : null;
}
