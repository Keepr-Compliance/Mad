/**
 * BACKLOG-3860 PR-3 — the Free trial card renders the state, the last change and the note, and offers
 * Edit only to a Super Admin (controls b, d, e, f). Rendered to a string; the dialog is closed.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/actions/trialSetting', () => ({ setSoloTrialAction: vi.fn() }));

import { FreeTrialCard } from '@/app/dashboard/plans/components/FreeTrialCard';
import { ABSENT, AUDIT_ROW, PRESENT_OFF, PRESENT_ON } from './fixtures';

const html = (props: Parameters<typeof FreeTrialCard>[0]) => renderToStaticMarkup(<FreeTrialCard {...props} />);
const stateText = (h: string) => /data-testid="free-trial-state"[^>]*>([^<]*)</.exec(h)?.[1];

describe('FreeTrialCard', () => {
  it('(e) renders Off when the setting row is absent', () => {
    expect(stateText(html({ setting: ABSENT, lastChange: null, canEdit: true }))).toBe('Off');
  });
  it('(e) renders Off from a present off row', () => {
    expect(stateText(html({ setting: PRESENT_OFF, lastChange: null, canEdit: true }))).toBe('Off');
  });
  it('(e) renders On, 14 days from a present on row', () => {
    expect(stateText(html({ setting: PRESENT_ON, lastChange: null, canEdit: false }))).toBe('On, 14 days');
  });
  it('says so when the setting could not be read, and offers no Edit', () => {
    const h = html({ setting: null, lastChange: null, canEdit: true });
    expect(h).toContain('could not be loaded');
    expect(h).not.toContain('free-trial-edit');
  });

  it('(b) shows Edit to a Super Admin', () => {
    expect(html({ setting: PRESENT_OFF, lastChange: null, canEdit: true })).toContain('data-testid="free-trial-edit"');
  });
  it('(b) hides Edit from everyone else, who still sees the state', () => {
    const h = html({ setting: PRESENT_ON, lastChange: AUDIT_ROW, canEdit: false });
    expect(h).not.toContain('free-trial-edit');
    expect(h).not.toContain('>Edit<');
    expect(stateText(h)).toBe('On, 14 days');
  });

  it('(d) shows who changed it, when, and old to new, from the audit row', () => {
    const h = html({ setting: PRESENT_ON, lastChange: AUDIT_ROW, canEdit: false });
    expect(h).toContain('Last changed by Staff Admin on Nov 2, 2026 (Off → On, 14 days)');
  });
  it('(d) says no changes are recorded when there is no audit row', () => {
    expect(html({ setting: PRESENT_OFF, lastChange: null, canEdit: false })).toContain('No changes recorded.');
  });

  it('(f) carries the new-trials-only note', () => {
    expect(html({ setting: PRESENT_OFF, lastChange: null, canEdit: false })).toContain(
      'A change applies to new trials only; running trials keep their end date.'
    );
  });
});
