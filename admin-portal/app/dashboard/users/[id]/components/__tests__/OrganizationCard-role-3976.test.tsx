// @vitest-environment jsdom

/**
 * BACKLOG-3976: Change Role moved to the profile header (UserProfileCard). The Organizations card
 * keeps the role badge and renders no Change Role.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrganizationCard } from '../OrganizationCard';

const BROKERAGE_A = {
  organization_id: 'org-a',
  org_name: 'Brokerage A',
  role: 'agent',
  joined_at: '2026-10-01T00:00:00.000Z',
  is_personal: false,
};
const BROKERAGE_B = { ...BROKERAGE_A, organization_id: 'org-b', org_name: 'Brokerage B', role: 'admin' };
const PERSONAL = { ...BROKERAGE_A, organization_id: 'org-p', org_name: 'Personal', role: 'admin', is_personal: true };

afterEach(cleanup);

describe('OrganizationCard', () => {
  it('shows each membership with its role badge and no Change Role button', () => {
    render(<OrganizationCard memberships={[BROKERAGE_A, BROKERAGE_B, PERSONAL]} />);
    expect(screen.queryByRole('button', { name: 'Change Role' })).toBeNull();
    expect(screen.getByText('Brokerage A').closest('li')?.textContent).toContain('agent');
    expect(screen.getByText('Brokerage B').closest('li')?.textContent).toContain('admin');
  });
});
