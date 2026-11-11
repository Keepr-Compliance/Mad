'use client';

/**
 * useGrantableRoles - the role ids the signed-in user may grant (BACKLOG-4168).
 *
 * Calls `can_grant_role` once per role. Returns null while loading, so callers
 * can show nothing grantable until the database has answered.
 */

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fetchGrantableRoleIds } from '@/lib/internal-roles';

export function useGrantableRoles(
  roles: Array<{ id: string; permission_keys?: string[] }>
): Set<string> | null {
  // Re-ask when a role's permissions change: that can move it above or below the caller.
  const key = useMemo(
    () => roles.map((r) => `${r.id}:${[...(r.permission_keys ?? [])].sort().join('|')}`).sort().join(','),
    [roles]
  );
  const [grantable, setGrantable] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(',').map((entry) => entry.split(':')[0]) : [];
    fetchGrantableRoleIds(createClient(), ids).then((set) => {
      if (!cancelled) setGrantable(set);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return grantable;
}
