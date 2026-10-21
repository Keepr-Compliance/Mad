/**
 * BACKLOG-4032 — the kit Dropdown renders and works in broker-portal's jest
 * environment through the '@keepr/ui' source mapping.
 *
 * This config runs no setup file (setupFilesAfterEnv is empty), so there are
 * no jest-dom matchers and no Radix polyfills (ResizeObserver,
 * scrollIntoView). Plain assertions only. Passing here shows the component
 * needs neither.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Dropdown } from '@keepr/ui';

const OPTIONS = [
  { value: 'admin', label: 'Admin', description: 'Manages users and billing' },
  { value: 'agent', label: 'Agent', description: 'Sees own transactions' },
  { value: 'billing', label: 'Billing', disabled: true, hint: 'Already billing contact' },
  { value: 'viewer', label: 'Viewer' },
];

describe('kit Dropdown in broker-portal (BACKLOG-4032)', () => {
  it('opens, filters, picks with the keyboard and closes', () => {
    const onChange = jest.fn();
    render(<Dropdown label="Role" options={OPTIONS} value="agent" onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: /Role\s+Agent/ });
    fireEvent.click(trigger);

    const search = screen.getByRole('combobox');
    expect(document.activeElement).toBe(search);
    expect(screen.getAllByRole('option').length).toBe(4);

    fireEvent.change(search, { target: { value: 'view' } });
    expect(screen.getAllByRole('option').length).toBe(1);

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('viewer');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
