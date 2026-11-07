/**
 * Internal-role helpers shared by the settings screens (BACKLOG-4168).
 *
 * The database decides which roles a caller may grant (`can_grant_role`) and
 * refuses every disallowed change with SQLSTATE 42501 'Not permitted'. These
 * helpers let the UI offer only what the database will accept and word a
 * refusal the same way everywhere.
 */

/** PostgREST error code for the role functions' single refusal. */
export const NOT_PERMITTED_CODE = '42501';

/** One message for every refusal, whichever control raised it. */
export const NOT_PERMITTED_MESSAGE = 'Not permitted. You can only manage users and roles below your own.';

type RpcError = { code?: string | null; message?: string | null } | null | undefined;

/** True when an RPC error is the role functions' refusal. */
export function isNotPermitted(error: RpcError): boolean {
  return !!error && error.code === NOT_PERMITTED_CODE;
}

/** User-facing text for an RPC error: the refusal gets the shared message. */
export function describeRoleError(error: RpcError, fallback: string): string {
  if (isNotPermitted(error)) return NOT_PERMITTED_MESSAGE;
  return error?.message || fallback;
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }>;
};

/**
 * Ask the database, once per role, whether the signed-in user may grant it.
 * A role whose check errors is treated as not grantable.
 */
export async function fetchGrantableRoleIds(client: RpcClient, roleIds: string[]): Promise<Set<string>> {
  const results = await Promise.all(
    roleIds.map(async (id) => {
      try {
        const { data, error } = await client.rpc('can_grant_role', { p_role_id: id });
        return !error && data === true ? id : null;
      } catch {
        return null;
      }
    }),
  );
  return new Set(results.filter((id): id is string => id !== null));
}

/**
 * Whether a set of permission keys is strictly below the caller's own keys:
 * every key held, and at least one held key left out. Mirrors the database
 * ceiling so the role editor can refuse before saving anything.
 */
export function isStrictlyBelow(keys: Iterable<string>, held: Set<string>): boolean {
  const wanted = new Set(keys);
  for (const k of wanted) if (!held.has(k)) return false;
  for (const k of held) if (!wanted.has(k)) return true;
  return false;
}
