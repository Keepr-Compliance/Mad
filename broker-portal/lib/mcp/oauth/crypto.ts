/**
 * Identifiers and digests for the OAuth server (BACKLOG-4238).
 *
 * A bytea value is sent to PostgREST as the text form '\x' + lowercase hex.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

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

/** A new access or refresh token: 'kpr_at_' / 'kpr_rt_' + base64url of 32 random bytes (43 characters). */
export function newToken(kind: 'at' | 'rt'): string {
  return `kpr_${kind}_${randomBytes(32).toString('base64url')}`;
}

/** Digest of a whole token, prefix included: HMAC(pepper, UTF-8 of the token), in bytea text form. */
export function digest(pepper: Buffer, token: string): string {
  return toBytea(hmac(pepper, Buffer.from(token, 'utf8')));
}

/** A new browser binding value: 'kpr_bd_' + base64url of 32 random bytes. */
export function newBinding(): string {
  return `kpr_bd_${randomBytes(32).toString('base64url')}`;
}

/** SHA-256 of a browser binding value, in bytea text form. */
export function bindingDigest(value: string): string {
  return toBytea(createHash('sha256').update(value, 'utf8').digest());
}
