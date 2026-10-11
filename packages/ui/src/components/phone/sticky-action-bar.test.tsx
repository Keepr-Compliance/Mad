import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { StickyActionBar, ACTION_BAR_HEIGHT_VAR } from './sticky-action-bar';

describe('StickyActionBar', () => {
  it('is fixed to the bottom, phone only, with safe-area padding', () => {
    render(<StickyActionBar><button type="button">Save</button></StickyActionBar>);
    const cls = screen.getByTestId('sticky-action-bar').className;
    expect(cls).toContain('fixed');
    expect(cls).toContain('bottom-0');
    expect(cls).toContain('md:hidden');
    expect(cls).toContain('pb-[calc(env(safe-area-inset-bottom,0px)_+_12px)]');
  });

  it('R8: publishes its height var while mounted and removes it on unmount', () => {
    const root = document.documentElement;
    const { unmount } = render(<StickyActionBar><button type="button">Save</button></StickyActionBar>);
    expect(root.style.getPropertyValue(ACTION_BAR_HEIGHT_VAR)).toMatch(/px$/);
    unmount();
    expect(root.style.getPropertyValue(ACTION_BAR_HEIGHT_VAR)).toBe('');
  });
});
