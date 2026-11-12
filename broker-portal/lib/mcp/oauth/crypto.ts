/**
 * Identifiers and digests for the OAuth server (BACKLOG-4238).
 *
 * A bytea value is sent to PostgREST as the text form '\x' + lowercase hex.
 */

import { createHmac, randomBytes } from 'node:crypto';

/** A new client id: 'kpr_c_' + base64url of 16 random bytes (22 characters). */
export function newClientId(): string {
  return `kpr_c_${randomBytes(16).toString('base64url')}`;
}

/** HMAC-SHA256 keyed with the pepper bytes. */
export function hmac(pepper: Buffer, data: Buffer | string): Buffer {
  return createHmac('sha256', pepper).update(data).digest();
}

/** Postgres bytea text form: a backslash, 'x', then lowercase hex. */
export function toBytea(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

/** Digest of a client address: HMAC(pepper, 'ip:' + ip). */
export function ipDigest(pepper: Buffer, ip: string): Buffer {
  return hmac(pepper, `ip:${ip}`);
}
