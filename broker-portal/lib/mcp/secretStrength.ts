/**
 * Strength rule for MCP_PORTAL_SECRET and MCP_TOKEN_PEPPER (BACKLOG-4259).
 *
 * Accepted formats:
 * - hex: only [0-9a-fA-F], even length. A string made only of hex digits is
 *   always read as hex, never as base64url.
 * - base64url: only [A-Za-z0-9_-], no padding, canonical (decoding and
 *   re-encoding gives the same string).
 *
 * Strong: decodes to at least MIN_SECRET_BYTES bytes, and those bytes hold at
 * least MIN_DISTINCT_BYTES different values.
 */

export const MIN_SECRET_BYTES = 32;
export const MIN_DISTINCT_BYTES = 16;

const HEX = /^[0-9a-fA-F]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The bytes a secret encodes, or null when it is neither accepted format. */
export function decodeSecret(raw: string): Buffer | null {
  if (HEX.test(raw)) {
    return raw.length % 2 === 0 ? Buffer.from(raw, 'hex') : null;
  }
  if (!BASE64URL.test(raw)) return null;
  const buf = Buffer.from(raw, 'base64url');
  return buf.toString('base64url') === raw ? buf : null;
}

/** True when the decoded bytes are long enough and varied enough. */
export function isStrongBytes(buf: Buffer): boolean {
  return buf.length >= MIN_SECRET_BYTES && new Set(buf).size >= MIN_DISTINCT_BYTES;
}

export function isStrongSecret(raw: string | undefined): boolean {
  if (!raw) return false;
  const buf = decodeSecret(raw);
  return buf !== null && isStrongBytes(buf);
}
