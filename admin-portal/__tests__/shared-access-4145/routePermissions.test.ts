/**
 * BACKLOG-4145: the user detail route also admits support.view (the page then checks the
 * requester rule); the users list page stays users.view only.
 */
import { describe, expect, it } from 'vitest';
import { requiredPermissionsFor } from '@/lib/route-permissions';

describe('route permissions for /dashboard/users (BACKLOG-4145)', () => {
  it('list page: users.view only', () => {
    expect(requiredPermissionsFor('/dashboard/users')).toEqual(['users.view']);
  });
  it('detail page: users.view or support.view', () => {
    expect(requiredPermissionsFor('/dashboard/users/user-1')).toEqual([
      'users.view',
      'support.view',
    ]);
  });
});
