/**
 * ClarityAnalytics consent-gating tests (BACKLOG-2133).
 *
 * The compliance-critical assertions:
 *   - Clarity.init is NOT called before the user consents.
 *   - Clarity.init IS called once the user accepts.
 *   - A stored decline keeps Clarity off; a GPC signal keeps it off.
 *
 * `@microsoft/clarity` is mocked so we assert on init() without loading the
 * real script. The dynamic import resolves on a microtask, so we await it.
 */

import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ClarityAnalytics from '@/components/analytics/ClarityAnalytics';
import { CONSENT_STORAGE_KEY } from '@/lib/consent/consent';

const initMock = jest.fn();
jest.mock('@microsoft/clarity', () => ({
  __esModule: true,
  default: { init: (...args: unknown[]) => initMock(...args) },
}));

function setGpc(value: boolean | undefined) {
  Object.defineProperty(navigator, 'globalPrivacyControl', {
    value,
    configurable: true,
  });
}

/** Flush the dynamic import()'s microtask + effects. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ClarityAnalytics (consent-gated)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setGpc(undefined);
    initMock.mockClear();
  });

  it('does NOT init Clarity before consent', async () => {
    render(<ClarityAnalytics projectId="vddzkwb27x" />);
    await flush();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('inits Clarity when the stored choice is accepted', async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'accepted');
    render(<ClarityAnalytics projectId="vddzkwb27x" />);
    await flush();
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith('vddzkwb27x');
  });

  it('does NOT init Clarity when the stored choice is declined', async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'declined');
    render(<ClarityAnalytics projectId="vddzkwb27x" />);
    await flush();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('does NOT init Clarity when GPC is asserted, even if accepted was stored', async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'accepted');
    setGpc(true);
    render(<ClarityAnalytics projectId="vddzkwb27x" />);
    await flush();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('inits Clarity once the user accepts in-session (no reload)', async () => {
    render(<ClarityAnalytics projectId="vddzkwb27x" />);
    await flush();
    expect(initMock).not.toHaveBeenCalled();

    // Simulate the banner persisting an accept + broadcasting the change.
    await act(async () => {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, 'accepted');
      window.dispatchEvent(new CustomEvent('keepr:consent-change'));
      await Promise.resolve();
    });

    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith('vddzkwb27x');
  });
});
