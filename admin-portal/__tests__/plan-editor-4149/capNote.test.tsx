// @vitest-environment jsdom

/**
 * BACKLOG-4149 A1 — the plan editor says the transaction cap is not applied while
 * Unlimited transactions is on, and follows the LIVE toggle (not the saved props).
 * The cap input stays editable: it still applies to any org on the plan whose
 * override turns Unlimited off.
 *
 * Real FeatureToggleList; the two definitions are transcribed from the live
 * feature_definitions rows (read-only, 2026-11-05). Identifiers are placeholders.
 *
 * Controls: note on the cap row always shown -> "off" red; note read from saved
 * props instead of the live toggle -> "follows the toggle" red; component without
 * the note -> "on" and "follows the toggle" red.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin-queries', () => ({ updatePlanFeature: vi.fn() }));
vi.mock('@/components/shared/ConfirmationDialog', () => ({ ConfirmationDialog: () => null }));

import { FeatureToggleList } from '@/app/dashboard/plans/components/FeatureToggleList';

const NOTE = 'Not applied while Unlimited transactions is on.';

const CAP_DEF = {
  id: 'fd-cap', key: 'max_transaction_size', name: 'Max Transaction Size',
  description: 'Maximum number of transactions per organization',
  category: 'compliance', value_type: 'integer', default_value: '10', min_tier: null,
  created_at: '2026-01-01',
};
const UNLIMITED_DEF = {
  id: 'fd-unl', key: 'unlimited_transactions', name: 'Unlimited transactions',
  description: 'Exports any transaction without an unlock or a credit.',
  category: 'export', value_type: 'boolean', default_value: 'false', min_tier: null,
  created_at: '2026-01-01',
};

const planFeature = (def: typeof CAP_DEF, enabled: boolean, value: string | null) => ({
  id: `pf-${def.id}`, plan_id: 'p1', feature_id: def.id, enabled, value, feature_definitions: def,
});

function renderEditor(unlimitedSaved: boolean) {
  return render(
    <FeatureToggleList
      planId="p1"
      planTier="team"
      features={[planFeature(CAP_DEF, true, '100'), planFeature(UNLIMITED_DEF, unlimitedSaved, null)]}
      allFeatures={[CAP_DEF, UNLIMITED_DEF]}
      dependencies={[]}
      canManage
    />,
  );
}

afterEach(cleanup);

describe('plan editor cap note (BACKLOG-4149)', () => {
  it('on: Unlimited transactions is on, so the cap row carries the note and the input stays editable', () => {
    renderEditor(true);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
    const input = screen.getByDisplayValue('100') as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });

  it('off: Unlimited transactions is off, so there is no note', () => {
    renderEditor(false);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('follows the toggle: switching Unlimited on before saving shows the note, off hides it', () => {
    renderEditor(false);
    expect(screen.queryByText(NOTE)).toBeNull();
    const switches = screen.getAllByRole('switch');
    // order follows the category sections; find the one whose row names the unlimited key
    const unlimitedSwitch = switches.find((s) => s.closest('div[class*="px-6"]')?.textContent?.includes('unlimited_transactions'));
    expect(unlimitedSwitch).toBeDefined();
    fireEvent.click(unlimitedSwitch as HTMLElement);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
    fireEvent.click(unlimitedSwitch as HTMLElement);
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
