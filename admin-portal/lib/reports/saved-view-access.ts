/**
 * Who a saved view belongs to, read from one `report_list_saved_views` row (BACKLOG-4087).
 *
 * ONE helper for every report's parser, so the rule below cannot drift between them.
 *
 * The RPC returns the caller's own rows first (`access: 'owner'`, no `owner_name`), then the rows
 * shared with them (`access: 'viewer' | 'editor'`, `owner_name` set, `pinned` and `is_default`
 * already masked false by the server). The RPC returns no owner id, so ownership is read from the
 * row's shape:
 *
 * - `access` is 'owner', 'editor' or 'viewer' and agrees with the shape: used as sent.
 * - `access` is anything else (an unknown string, a number, null): VIEWER. Fails closed.
 * - `access` is 'owner' but the row carries `owner_name` (only shared rows do): VIEWER. Fails closed.
 * - `access` is missing and there is no `owner_name`: OWNER. This is the shape of every row from a
 *   database that predates sharing, where every listed row is the caller's own.
 * - `access` is missing and `owner_name` is present: VIEWER.
 *
 * `pinned` and `isDefault` are true only on owner rows: a view shared with the user is apply-only
 * and never their default or one of their cards, whatever the row says. The server masks both
 * already; this is the second guard.
 *
 * Hiding buttons on non-owner rows is presentation only. The server functions are the access guard.
 */

import type { SavedViewAccess } from '@keepr/ui';

export type ViewAccess = SavedViewAccess;

/** The fields every report's parsed view carries for sharing. Optional so older fixtures still type-check. */
export interface SharedViewFields {
  /** The caller's access. Missing means owner (the kit's rule). The parsers always set it. */
  access?: ViewAccess;
  /** Who shared it; set on shared rows only. */
  ownerName?: string;
  /**
   * True when the server sent an `access` field, i.e. its list function is the one that ships with
   * the share functions. The share UI is offered only then.
   */
  accessFromServer?: boolean;
}

export interface ParsedViewAccess {
  access: ViewAccess;
  ownerName?: string;
  accessFromServer: boolean;
  /** `row.pinned === true`, on owner rows only. */
  pinned: boolean;
  /** `row.is_default === true`, on owner rows only. */
  isDefault: boolean;
}

const SHARED_ACCESS: readonly ViewAccess[] = ['viewer', 'editor'];

export function parseViewAccess(row: Record<string, unknown>): ParsedViewAccess {
  const rawOwnerName = row.owner_name;
  const hasOwnerName = rawOwnerName !== undefined && rawOwnerName !== null;
  const accessFromServer = Object.prototype.hasOwnProperty.call(row, 'access');
  const sent = row.access;

  let access: ViewAccess;
  if (!accessFromServer) {
    access = hasOwnerName ? 'viewer' : 'owner';
  } else if (sent === 'owner') {
    access = hasOwnerName ? 'viewer' : 'owner';
  } else if (typeof sent === 'string' && (SHARED_ACCESS as readonly string[]).includes(sent)) {
    access = sent as ViewAccess;
  } else {
    access = 'viewer';
  }

  const own = access === 'owner';
  const ownerName =
    !own && typeof rawOwnerName === 'string' && rawOwnerName.trim().length > 0 ? rawOwnerName : undefined;

  return {
    access,
    ...(own ? {} : { ownerName: ownerName ?? 'another user' }),
    accessFromServer,
    pinned: own && row.pinned === true,
    isDefault: own && row.is_default === true,
  };
}

/** The view's access fields only, for spreading into a parsed view. */
export function viewAccessFields(parsed: ParsedViewAccess): SharedViewFields {
  return {
    access: parsed.access,
    ...(parsed.ownerName !== undefined ? { ownerName: parsed.ownerName } : {}),
    accessFromServer: parsed.accessFromServer,
  };
}

/** The user's own view. A missing `access` is the user's own (pre-sharing rows and fixtures). */
export function isOwnView(view: { access?: ViewAccess }): boolean {
  return view.access === undefined || view.access === 'owner';
}
