/**
 * One log line per OAuth request (BACKLOG-4238).
 *
 * Parameter NAMES are logged only when they are on the route's fixed list;
 * every other name is counted, not written. Values are never logged. The whole
 * serialised line passes through redactKpr.
 */

import { redactKpr } from './redact';

export const REGISTER_LOG_KEYS: readonly string[] = [
  'redirect_uris',
  'client_name',
  'grant_types',
  'response_types',
  'token_endpoint_auth_method',
  'scope',
  'application_type',
  'client_uri',
  'logo_uri',
  'contacts',
  'tos_uri',
  'policy_uri',
  'jwks_uri',
  'jwks',
  'software_id',
  'software_version',
  'software_statement',
];

export const TOKEN_LOG_KEYS: readonly string[] = [
  'grant_type',
  'code',
  'redirect_uri',
  'client_id',
  'code_verifier',
  'refresh_token',
  'resource',
  'scope',
  'client_secret',
  'client_assertion',
  'client_assertion_type',
];

export interface LoggedKeys {
  keys: string[];
  otherKeys: number;
}

/** The names on the allowlist (sorted, once each) and a count of the rest. */
export function filterKeys(names: readonly string[], allowlist: readonly string[]): LoggedKeys {
  const allowed = new Set(allowlist);
  const kept = new Set<string>();
  let other = 0;
  for (const name of names) {
    if (allowed.has(name)) kept.add(name);
    else other += 1;
  }
  return { keys: [...kept].sort(), otherKeys: other };
}

export interface Outcome {
  route: string;
  outcome: string;
  status: number;
  ms: number;
  keys?: string[];
  otherKeys?: number;
  /** error.name after errorNameTag(), or a database error code checked by dbCode(). */
  error?: string;
  missing?: string[];
  /** Token route only: 'authorization_code', 'refresh_token' or 'other'. */
  grant?: string;
}

const ERROR_NAMES = new Set(['TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError']);

/** A thrown value's name, reduced to a fixed list. */
export function errorNameTag(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'Other';
}

/** A database error code when it has a known shape (SQLSTATE or PGRSTnnn), else 'none'. */
export function dbCode(code: unknown): string {
  return typeof code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code) ? code : 'none';
}

export function logOutcome(o: Outcome): void {
  const line = redactKpr(`[mcp-oauth] ${JSON.stringify(o)}`);
  if (o.status >= 500) console.error(line);
  else console.warn(line);
}
