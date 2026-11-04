/**
 * BACKLOG-4032 slice 2 — Dropdown presentation="sheet" (a BottomSheet on
 * Radix Dialog) works in broker-portal's jest environment through the
 * '@keepr/ui' source mapping. Plain assertions, fireEvent only, like
 * dropdown-smoke.test.tsx.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Dropdown } from '@keepr/ui';

const OPTIONS = [
  { value: 'admin', label: 'Admin', description: 'Manages users and billing' },
  { value: 'agent', label: 'Agent', description: 'Sees own transactions' },
  { value: 'viewer', label: 'Viewer' },
];

describe('kit Dropdown sheet in broker-portal (BACKLOG-4032)', () => {
  it('opens a sheet, picks with the keyboard, closes and returns focus to the trigger', async () => {
    const onChange = jest.fn();
    render(<Dropdown label="Role" presentation="sheet" options={OPTIONS} value="agent" onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: /Role\s+Agent/ });
    fireEvent.click(trigger);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.getByRole('dialog', { name: 'Role' })).toBeTruthy();
    const search = screen.getByRole('combobox');
    expect(document.activeElement).toBe(search);

    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('admin');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
