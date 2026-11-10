/**
 * Sender rules — data access for the admin page (BACKLOG-4186).
 *
 * Reads (any grant on the 'sender-rules' report; BACKLOG-4186 PR A,
 * supabase/migrations/20261109210000_backlog_4186_sender_rule_set_reads.sql):
 *   sender_rule_set_admin_state()              -> state()
 *   sender_rule_set_admin_content(p_version)   -> content(version)
 * Writes (report owner only; supabase/migrations/20261107235503_backlog_4175_sender_rule_sets.sql):
 *   sender_rule_set_publish(p_content, p_pin_org)  -> publishCanary / publishRelease / promote
 *   sender_rule_set_pin(p_org, p_version)          -> unpin (p_version NULL)
 *   sender_rule_set_revert_all()                   -> revertAll
 *
 * p_pin_org NULL means "release to every org". It is therefore ALWAYS sent explicitly: a canary
 * sends the org id, a release sends null. A canary with no org is refused here before any call,
 * because an omitted p_pin_org defaults to NULL on the server and would publish to everyone.
 *
 * promote(version) re-publishes the content stored for that version, fetched from the server,
 * never the editor's state.
 *
 * Every refusal becomes a SenderRulesError {code, message, kind, blocks?}.
 */

import { blockLines } from './blocks';
import type { RuleSetPinRow, RuleSetVersionRow, SenderRuleSet, SenderRulesAdminState } from './types';
import { invalidReason, parseRuleSet } from './validate';

/** The part of a Supabase client this module uses. */
export interface RpcError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export type SenderRulesErrorKind =
  | 'not_allowed' // 42501
  | 'invalid' // 22023 "Invalid rule set: ..."
  | 'guard' // 22023 with a DETAIL list: must run on a test org first
  | 'org_not_found' // 22023 "Organization not found"
  | 'org_required' // refused here: a canary or unpin with no org
  | 'version_not_found' // 22023 "Version not found", or promote of a missing version
  | 'pin_below' // 22023 "Cannot pin below the latest released version..."
  | 'unreadable' // a read answered with something that is not the documented shape
  | 'unknown';

export class SenderRulesError extends Error {
  readonly code: string | null;
  readonly kind: SenderRulesErrorKind;
  /** The guard's refused changes in words (kind 'guard' only). */
  readonly blocks?: string[];

  constructor(kind: SenderRulesErrorKind, message: string, code: string | null = null, blocks?: string[]) {
    super(message);
    this.name = 'SenderRulesError';
    this.kind = kind;
    this.code = code;
    if (blocks) this.blocks = blocks;
  }
}

/** A PostgREST error from one of the RPCs above -> a SenderRulesError. */
export function toSenderRulesError(e: RpcError): SenderRulesError {
  const code = e.code ?? null;
  const msg = e.message ?? '';
  if (code === '42501') return new SenderRulesError('not_allowed', "You can't change these rules.", code);
  if (code === '22023') {
    if (msg.startsWith('Invalid rule set: ')) return new SenderRulesError('invalid', msg, code);
    if (e.details) {
      const lines = blockLines(e.details);
      if (lines.length > 0) {
        return new SenderRulesError('guard', 'These changes must run on a test org first:', code, lines);
      }
    }
    if (msg === 'Organization not found') return new SenderRulesError('org_not_found', msg, code);
    if (msg === 'Organization required') return new SenderRulesError('org_required', msg, code);
    if (msg === 'Version not found') return new SenderRulesError('version_not_found', msg, code);
    if (msg.startsWith('Cannot pin below')) return new SenderRulesError('pin_below', msg, code);
  }
  return new SenderRulesError('unknown', msg || 'Unknown error', code);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function versionRow(v: unknown): RuleSetVersionRow | null {
  if (!isObj(v)) return null;
  if (!isInt(v.version) || typeof v.released !== 'boolean' || typeof v.bundled !== 'boolean') return null;
  if (!isStrOrNull(v.canary_org) || !isStrOrNull(v.canary_org_name) || !isStr(v.published_at)) return null;
  return {
    version: v.version,
    released: v.released,
    bundled: v.bundled,
    canary_org: v.canary_org,
    canary_org_name: v.canary_org_name,
    published_at: v.published_at,
  };
}

function pinRow(v: unknown): RuleSetPinRow | null {
  if (!isObj(v)) return null;
  if (!isStr(v.org_id) || !isStrOrNull(v.org_name) || !isInt(v.version) || !isStr(v.pinned_at)) return null;
  return { org_id: v.org_id, org_name: v.org_name, version: v.version, pinned_at: v.pinned_at };
}

/**
 * sender_rule_set_admin_state()'s answer, or null when it is not the documented object. Never
 * throws: the page shows "could not be read" for null.
 */
export function parseAdminState(v: unknown): SenderRulesAdminState | null {
  if (!isObj(v)) return null;
  if (!(v.released_version === null || isInt(v.released_version))) return null;
  if (typeof v.truncated !== 'boolean' || !Array.isArray(v.versions) || !Array.isArray(v.pins)) return null;
  const versions = v.versions.map(versionRow);
  const pins = v.pins.map(pinRow);
  if (versions.some((r) => r === null) || pins.some((r) => r === null)) return null;
  return {
    released_version: v.released_version,
    truncated: v.truncated,
    versions: versions as RuleSetVersionRow[],
    pins: pins as RuleSetPinRow[],
  };
}

export interface SenderRulesApi {
  state(): Promise<SenderRulesAdminState>;
  /** The stored content of one version, or null when no such version exists. */
  content(version: number): Promise<SenderRuleSet | null>;
  /** Publish to ONE org (a canary). Returns the new version. */
  publishCanary(content: SenderRuleSet, orgId: string): Promise<number>;
  /** Publish to every org (a release; guarded). Returns the new version. */
  publishRelease(content: SenderRuleSet): Promise<number>;
  /** Release the content stored for `version`, as fetched from the server. */
  promote(version: number): Promise<number>;
  /** End one org's test. */
  unpin(orgId: string): Promise<void>;
  /** Every org back to the shipped rules; ends every test. Returns the new version. */
  revertAll(): Promise<number>;
}

export function createSenderRulesApi(client: RpcClient): SenderRulesApi {
  async function call(fn: string, args?: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw toSenderRulesError(error);
    return data;
  }

  function requireOrg(orgId: unknown): string {
    if (typeof orgId !== 'string' || orgId.trim() === '') {
      throw new SenderRulesError('org_required', 'Pick a test organization first.');
    }
    return orgId;
  }

  function requireValid(content: unknown): void {
    const reason = invalidReason(content);
    if (reason !== null) throw new SenderRulesError('invalid', 'Invalid rule set: ' + reason);
  }

  function newVersion(v: unknown): number {
    if (!isInt(v)) throw new SenderRulesError('unreadable', 'The server did not return a version.');
    return v;
  }

  async function publishRelease(content: SenderRuleSet): Promise<number> {
    requireValid(content);
    return newVersion(await call('sender_rule_set_publish', { p_content: content, p_pin_org: null }));
  }

  async function content(version: number): Promise<SenderRuleSet | null> {
    const data = await call('sender_rule_set_admin_content', { p_version: version });
    if (data === null || data === undefined) return null;
    const parsed = parseRuleSet(data);
    if (parsed === null) throw new SenderRulesError('unreadable', 'Version ' + version + ' could not be read.');
    return parsed;
  }

  return {
    async state() {
      const parsed = parseAdminState(await call('sender_rule_set_admin_state'));
      if (parsed === null) throw new SenderRulesError('unreadable', 'The sender rules could not be read.');
      return parsed;
    },
    content,
    async publishCanary(c, orgId) {
      const org = requireOrg(orgId);
      requireValid(c);
      return newVersion(await call('sender_rule_set_publish', { p_content: c, p_pin_org: org }));
    },
    publishRelease,
    async promote(version) {
      const stored = await content(version);
      if (stored === null) throw new SenderRulesError('version_not_found', 'Version not found');
      return publishRelease(stored);
    },
    async unpin(orgId) {
      const org = requireOrg(orgId);
      await call('sender_rule_set_pin', { p_org: org, p_version: null });
    },
    async revertAll() {
      return newVersion(await call('sender_rule_set_revert_all'));
    },
  };
}
