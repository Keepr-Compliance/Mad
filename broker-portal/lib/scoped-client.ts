/**
 * Scoped Impersonation Client
 *
 * TASK-2134: Creates a Proxy-wrapped Supabase client that automatically
 * restricts data access during impersonation sessions.
 *
 * Defense-in-depth: even if a page forgets to add .eq('organization_id', orgId),
 * the scoped client ensures queries only return data for the target user's org.
 *
 * Security guarantees:
 * 1. All SELECT queries on scoped tables auto-filter to the target user or
 *    their organization
 * 2. All write operations (.insert/.update/.delete/.upsert) throw errors
 * 3. The underlying service-role client is never exposed directly
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Tables that are scoped by organization_id during impersonation.
 * Queries to these tables will automatically include .eq('organization_id', orgId).
 */
const ORG_SCOPED_TABLES = new Set([
  'transaction_submissions',
]);

/**
 * Tables that are scoped by user_id during impersonation.
 * Queries to these tables will automatically include .eq('user_id', targetUserId).
 */
const USER_SCOPED_TABLES = new Set([
  'organization_members',
  // BACKLOG-3079: one row per user, keyed by user_id. It carries NO
  // organization_id, which is why it is scoped here and not by org.
  'user_preferences',
]);

/**
 * Tables that are scoped by their own primary key (id = user_id).
 * Queries to these tables will automatically include .in('id', [targetUserId]).
 *
 * BACKLOG-3079 adds `users`: /dashboard/account reads the target person's name,
 * email and auth provider straight from it. /dashboard/users never needed this
 * because it reaches user rows through an embedded `user:users!…` selector on
 * organization_members, which PostgREST resolves as part of that query and
 * never routes through .from('users') at all.
 */
const ID_SCOPED_TABLES = new Set([
  'profiles',
  'users',
]);

/**
 * Tables scoped by their own id matching the TARGET USER'S ORGANIZATION.
 * Queries will automatically include .eq('id', organizationId).
 *
 * Distinct from ORG_SCOPED_TABLES, which filters an `organization_id` COLUMN.
 * `organizations` has no such column — its own `id` is the organization.
 */
const ORG_ID_SCOPED_TABLES = new Set([
  'organizations',
]);

/**
 * All known tables that may be queried during impersonation.
 *
 * Note: submission_messages and submission_attachments are "submission child" tables.
 * They don't need auto-scoping because they're queried by submission_id,
 * and the parent submission is already org-scoped.
 */
const ALLOWED_TABLES = new Set([
  'transaction_submissions',
  'organization_members',
  'profiles',
  'submission_messages',
  'submission_attachments',
  // BACKLOG-3079: /dashboard/account. A table missing from this set does not
  // read as empty during impersonation — createBlockedQueryBuilder THROWS on
  // every method, so the page 500s for the support session it exists to serve.
  // That failure is invisible to any test that mocks getDataClient.
  'users',
  'user_preferences',
  'organizations',
]);

/**
 * Write methods that must be blocked during impersonation.
 */
const WRITE_METHODS = new Set(['insert', 'update', 'delete', 'upsert']);

/**
 * Creates a scoped Supabase client for impersonation sessions.
 *
 * The returned client looks and behaves like a regular SupabaseClient,
 * but all queries are automatically scoped to the target user's data.
 *
 * @param serviceClient - The service-role client (bypasses RLS)
 * @param targetUserId - The impersonated user's ID
 * @param organizationId - The impersonated user's organization ID
 * @returns A Proxy-wrapped client that enforces data scoping
 */
export function createScopedClient(
  serviceClient: SupabaseClient,
  targetUserId: string,
  organizationId: string,
): SupabaseClient {
  return new Proxy(serviceClient, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => {
          const queryBuilder = target.from(table);

          // For unknown tables, block access entirely during impersonation
          if (!ALLOWED_TABLES.has(table)) {
            return createBlockedQueryBuilder(table);
          }

          return createScopedQueryBuilder(
            queryBuilder,
            table,
            targetUserId,
            organizationId,
          );
        };
      }

      // Block auth operations during impersonation
      if (prop === 'auth') {
        return createReadOnlyAuth(target.auth);
      }

      // Pass through everything else (rpc, storage, etc.)
      return Reflect.get(target, prop, receiver);
    },
  }) as SupabaseClient;
}

/**
 * Wraps a query builder to auto-inject scoping filters on select()
 * and block write operations.
 */
function createScopedQueryBuilder(
  queryBuilder: ReturnType<SupabaseClient['from']>,
  table: string,
  targetUserId: string,
  organizationId: string,
) {
  return new Proxy(queryBuilder, {
    get(target, prop) {
      // Block write operations
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return () => {
          throw new Error(
            `Write operation '${prop}' is blocked during impersonation on table '${table}'`
          );
        };
      }

      // Intercept select() to auto-inject scoping filters
      if (prop === 'select') {
        return (...args: Parameters<typeof target.select>) => {
          let result = target.select(...args);

          // Auto-inject organization scoping
          if (ORG_SCOPED_TABLES.has(table)) {
            result = result.eq('organization_id', organizationId);
          }

          // Auto-inject user_id scoping
          if (USER_SCOPED_TABLES.has(table)) {
            result = result.eq('user_id', targetUserId);
          }

          // Auto-inject id-based scoping (profiles, users)
          if (ID_SCOPED_TABLES.has(table)) {
            result = result.in('id', [targetUserId]);
          }

          // Auto-inject organization identity scoping (organizations)
          if (ORG_ID_SCOPED_TABLES.has(table)) {
            result = result.eq('id', organizationId);
          }

          // Submission child tables (submission_messages, submission_attachments):
          // no auto-filter needed -- scoped by submission_id which belongs to the user's org

          return result;
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

/**
 * Creates a query builder that blocks all operations on an unknown table.
 */
function createBlockedQueryBuilder(table: string) {
  const handler = {
    get(_target: object, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      return () => {
        throw new Error(
          `Access to table '${table}' is not allowed during impersonation. ` +
          `Add it to ALLOWED_TABLES in scoped-client.ts if needed.`
        );
      };
    },
  };
  return new Proxy({}, handler);
}

/**
 * Wraps auth to prevent session manipulation during impersonation.
 * Only getUser/getSession are allowed (read-only).
 */
function createReadOnlyAuth(auth: SupabaseClient['auth']) {
  return new Proxy(auth, {
    get(target, prop) {
      // Allow read-only auth methods
      if (prop === 'getUser' || prop === 'getSession') {
        return Reflect.get(target, prop).bind(target);
      }

      // Block write auth methods
      const blockedAuthMethods = new Set([
        'signUp', 'signIn', 'signOut', 'updateUser',
        'signInWithPassword', 'signInWithOAuth',
        'resetPasswordForEmail', 'admin',
      ]);

      if (typeof prop === 'string' && blockedAuthMethods.has(prop)) {
        return () => {
          throw new Error(
            `Auth operation '${prop}' is blocked during impersonation`
          );
        };
      }

      return Reflect.get(target, prop);
    },
  });
}
