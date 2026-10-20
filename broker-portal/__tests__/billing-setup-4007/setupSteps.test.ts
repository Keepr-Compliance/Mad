/**
 * @jest-environment node
 *
 * BACKLOG-4007 PR-3 (C-G1): Billing comes before Connect Microsoft (founder 88a1f065).
 */
import { setupStepFor } from '@/lib/billing/setupSteps';

const base = { role: 'admin', hasMicrosoftTenant: false, signInProvider: 'azure', requested: null };

describe('setup guide step order', () => {
  it('C-G1: while the deal waits, the Billing step is shown whatever the URL asks for', () => {
    for (const requested of [null, 'microsoft', 'done', 'billing']) {
      expect(setupStepFor({ ...base, state: 'waiting_for_setup', requested })).toBe('billing');
    }
  });

  it('after billing: an admin signed in with Microsoft and no tenant -> Connect Microsoft', () => {
    expect(setupStepFor({ ...base, state: 'active' })).toBe('microsoft');
  });

  it('"Skip for now" (step=done) -> Done', () => {
    expect(setupStepFor({ ...base, state: 'active', requested: 'done' })).toBe('done');
  });

  it.each([
    ['a broker (cannot grant tenant consent)', { role: 'broker' }],
    ['a Google sign-in', { signInProvider: 'google' }],
    ['a brokerage already connected', { hasMicrosoftTenant: true }],
  ])('%s -> Done', (_l, over) => {
    expect(setupStepFor({ ...base, state: 'active', ...over })).toBe('done');
  });
});
