# Security Patterns

**Status:** Reference documentation for security practices
**Last Updated:** 2024-12-27

---

## Overview

Magic Audit implements defense-in-depth security with multiple layers of protection.

**Current Security Rating:** 8.5/10

---

## SQL Injection Protection

### Layer 1: Parameterized Queries (100% Coverage)

All database operations use parameterized queries via better-sqlite3 prepared statements.

**Location:** electron/services/db/core/dbConnection.ts

Helper functions:
- dbGet - Single row queries
- dbAll - Multi-row queries
- dbRun - INSERT/UPDATE/DELETE

### Layer 2: SQL Field Whitelist

Dynamic field names validated against whitelist.

**Location:** electron/utils/sqlFieldWhitelist.ts

Tables: users_local, oauth_tokens, contacts, transactions, communications, transaction_contacts

### Layer 3: Input Validation

All IPC inputs validated before database layer.

**Location:** electron/utils/validation.ts

### Layer 4: Query Timeout

busy_timeout = 5000 prevents query hangs.

---

## XSS Protection

### Layer 1: React Auto-Escaping

React escapes JSX content automatically.

### Layer 2: Content Security Policy

**Location:** electron/main.ts - setupContentSecurityPolicy()

Key protections: script-src self, object-src none, frame-ancestors none

### Layer 3: Electron Context Isolation

contextIsolation: true, nodeIntegration: false

---

## Command Injection Protection

### Layer 1: UDID Validation

Device UDIDs validated before spawn/exec.

Formats: Traditional (40 hex), Modern (8-4-16), Simulator (UUID)

### Layer 2: Path Validation

Blocks: path traversal (.., ~), shell metacharacters

### Layer 3: Spawn Argument Arrays

Use spawn() with arrays, not shell strings.

---

## Authentication Protection

### Token Storage

SQLCipher AES-256 encryption.

### Session Validation

All IPC handlers validate session tokens.

---

## Data Validation Patterns

### String Length Limits

| Field | Max |
|-------|-----|
| Email | 254 |
| File path | 4096 |
| Name | 200 |
| Notes | 10000 |
| Auth code | 1000 |

### Prototype Pollution Prevention

Removes __proto__, constructor, prototype keys.

---

## Supabase functions and grants

Applies to every file under `supabase/migrations/`. Background: BACKLOG-3553, BACKLOG-3611, BACKLOG-3646, BACKLOG-3549.

### Why

Supabase's default privileges give `anon`, `authenticated` and `PUBLIC` EXECUTE on every function created in `public`, and give `anon`/`authenticated` broad privileges (TRUNCATE included) on every new table. `anon` means any request carrying the public key, signed in or not. A `SECURITY DEFINER` function runs as its owner, so RLS on the tables it reads does not apply: the only protection is the grant list and the check inside the body.

### Rules

1. **Revoke by default, grant by need.** In the migration that creates or replaces a function:

   ```sql
   REVOKE EXECUTE ON FUNCTION public.my_fn(uuid, text) FROM PUBLIC, anon;
   GRANT  EXECUTE ON FUNCTION public.my_fn(uuid, text) TO authenticated;   -- only if a signed-in client calls it
   GRANT  EXECUTE ON FUNCTION public.my_fn(uuid, text) TO service_role;    -- only if a server or edge function calls it
   ```

   - Name the full signature; with overloads a bare name is an error.
   - `REVOKE ... FROM PUBLIC` alone does not remove an explicit `anon` grant, and `REVOKE ... FROM anon` alone leaves `anon` its EXECUTE through `PUBLIC`. Both terms are needed.
   - Server-only functions (called with the service-role key) also revoke `authenticated`.

2. **Every `SECURITY DEFINER` function checks its caller in the body.**

   ```sql
   IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
     RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
   END IF;
   ```

   - `auth.uid() IS NULL` alone only stops `anon`; every signed-in customer passes it. Add the check the data needs: internal role, org membership, `p_user_id = auth.uid()`, or `auth.role() = 'service_role'`.
   - Alias the table in the check (`ir.user_id`). An unaliased `user_id` is ambiguous inside a function whose `RETURNS TABLE` has a `user_id` column, and the call then fails for every caller.
   - Prefer `SECURITY INVOKER` when RLS on the underlying tables already expresses the rule.

3. **Intentionally public functions are labelled.** A function that must work signed-out (an invite-token lookup, the public support form) keeps its `anon` grant, says so in a comment in its migration (`-- Intentionally callable by anon: <flow>`), and still validates its inputs inside.

4. **New tables: no TRUNCATE for client roles.**

   ```sql
   REVOKE TRUNCATE ON public.my_table FROM anon, authenticated;
   ```

   RLS policies never evaluate TRUNCATE (BACKLOG-3549).

5. **Default privileges are a backstop.** An `ALTER DEFAULT PRIVILEGES` migration covers only objects created afterwards, by the role it names. Write the REVOKE in every migration anyway.

### Verify (in a rolled-back transaction on a test database)

- `select has_function_privilege('anon', 'public.my_fn(uuid,text)', 'EXECUTE')` returns `false`.
- Call as `anon` and as a non-privileged `authenticated` user: `42501`. Call as the intended caller: success, with fixture data so the result is non-empty.
- Mutation: drop the `anon` term (and separately the `PUBLIC` term) from the REVOKE, re-run, and watch the `anon` probe succeed. A control that cannot go red proves nothing.

### RLS helper functions

A function called inside an RLS policy expression needs EXECUTE for the role running the query. Revoking `anon` from a helper used by a policy that applies `TO public` can turn `anon` reads of that table from empty results into permission errors. Retarget the policy `TO authenticated` first, or query the table as `anon` before and after on a test database.

---

## Security Checklist for New Features

### Database Operations
- Parameterized statements only
- Field names in whitelist
- UUIDs validated
- Typed results
- Supabase migrations: REVOKE EXECUTE from PUBLIC/anon on new functions, caller check inside every SECURITY DEFINER body, no TRUNCATE for client roles on new tables (see *Supabase functions and grants*)

### IPC Handlers
- Validate all inputs
- Length limits on strings
- Sanitize objects
- No stack traces to renderer

### File Operations
- validateFilePath()
- No traversal sequences
- Max 4096 chars
- Expected directories only

### External Commands
- validateDeviceUdid()
- validateExecutablePath()
- spawn() with arrays
- No shell concatenation

### Renderer Content
- React JSX rendering
- No dangerouslySetInnerHTML
- Validate external URLs
- No eval()

### Secrets
- Never log secrets
- Never send to renderer
- Use environment variables
- Secure key derivation

---

## Adding New Validation

1. Add to electron/utils/validation.ts
2. Use ValidationError pattern
3. Add tests
4. Document here

---

## References

- Validation: electron/utils/validation.ts
- Field whitelist: electron/utils/sqlFieldWhitelist.ts
- DB connection: electron/services/db/core/dbConnection.ts
- CSP: electron/main.ts
- Preload: electron/preload/*.ts
