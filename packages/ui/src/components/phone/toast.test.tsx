import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { Toast } from './toast';

describe('Toast', () => {
  afterEach(() => jest.useRealTimers());

  it('R8: the role=status live region is mounted while closed', () => {
    render(<Toast open={false} message="Saved" onOpenChange={() => {}} />);
    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent('');
  });

  it('opening inserts the message into the SAME region', () => {
    const { rerender } = render(<Toast open={false} message="Saved" onOpenChange={() => {}} />);
    const before = screen.getByRole('status');
    rerender(<Toast open message="Saved" onOpenChange={() => {}} />);
    expect(screen.getByRole('status')).toBe(before);
    expect(before).toHaveTextContent('Saved');
  });

  it('closes itself at duration, not before', () => {
    jest.useFakeTimers();
    const onOpenChange = jest.fn();
    render(<Toast open message="Saved" onOpenChange={onOpenChange} duration={4000} />);
    act(() => jest.advanceTimersByTime(3999));
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sits above the action bar and offline banner offsets', () => {
    render(<Toast open message="Saved" onOpenChange={() => {}} />);
    const cls = screen.getByRole('status').className;
    expect(cls).toContain('var(--keepr-action-bar-h');
    expect(cls).toContain('var(--keepr-offline-banner-h');
  });
});
