/**
 * ConsentBanner behavior tests (BACKLOG-2133).
 *
 * - Shown on first visit (no choice, no GPC).
 * - Accept / Decline persist the choice and dismiss the banner.
 * - Not shown when a choice is already stored.
 * - Not shown (silently) when GPC is asserted.
 */

import { fireEvent, render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConsentBanner } from '@/components/consent/ConsentBanner';
import { CONSENT_STORAGE_KEY } from '@/lib/consent/consent';

function setGpc(value: boolean | undefined) {
  Object.defineProperty(navigator, 'globalPrivacyControl', {
    value,
    configurable: true,
  });
}

describe('ConsentBanner', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setGpc(undefined);
  });

  it('shows the banner on first visit with Accept, Decline, and a Cookie Policy link', () => {
    render(<ConsentBanner />);
    expect(screen.getByRole('region', { name: /cookie consent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /cookie policy/i });
    expect(link).toHaveAttribute('href', '/cookies');
  });

  it('persists accepted and hides the banner when Accept is clicked', () => {
    render(<ConsentBanner />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    });
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('accepted');
    expect(screen.queryByRole('region', { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it('persists declined and hides the banner when Decline is clicked', () => {
    render(<ConsentBanner />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    });
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('declined');
    expect(screen.queryByRole('region', { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it('does not show the banner when a choice was already stored (persistence across visits)', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'declined');
    render(<ConsentBanner />);
    expect(screen.queryByRole('region', { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it('does not show the banner when GPC is asserted (silent opt-out)', () => {
    setGpc(true);
    render(<ConsentBanner />);
    expect(screen.queryByRole('region', { name: /cookie consent/i })).not.toBeInTheDocument();
  });
});
