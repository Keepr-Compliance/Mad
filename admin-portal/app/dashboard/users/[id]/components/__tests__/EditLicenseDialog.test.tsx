/**
 * EditLicenseDialog — license type options (BACKLOG-3857)
 *
 * 'trial' is no longer a license type: the dialog offers exactly
 * 'individual' and 'team'. Static render; router and RPC are mocked.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/admin-queries', () => ({ updateLicense: vi.fn() }));

import { EditLicenseDialog } from '../EditLicenseDialog';

function optionValues(markup: string, selectId: string): string[] {
  const select = markup.match(new RegExp(`<select[^>]*id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
  if (!select) throw new Error(`no <select id="${selectId}"> in markup`);
  return [...select[1].matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
}

describe('EditLicenseDialog license type', () => {
  it('offers exactly individual and team', () => {
    const markup = renderToStaticMarkup(
      <EditLicenseDialog
        license={{ id: 'lic-1', status: 'active', expires_at: null, license_type: 'individual' }}
      />
    );
    expect(optionValues(markup, 'license-type')).toEqual(['individual', 'team']);
  });

  it('does not offer trial even when the license is still typed trial', () => {
    const markup = renderToStaticMarkup(
      <EditLicenseDialog
        license={{ id: 'lic-2', status: 'active', expires_at: null, license_type: 'trial' }}
      />
    );
    expect(optionValues(markup, 'license-type')).not.toContain('trial');
  });
});
