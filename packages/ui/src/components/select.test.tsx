import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './select';

/**
 * Radix Select's open/select flow is unreliable under jsdom (pointer capture +
 * positioning + scroll). We assert only the CLOSED trigger here — role, label
 * association, placeholder, and disabled state. Open/select interaction is
 * covered by real-browser QA, not jsdom.
 */
describe('Select (closed trigger)', () => {
  it('renders a combobox trigger with placeholder and label', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Status">
          <SelectValue placeholder="Choose a status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="open">Open</SelectItem>
          <SelectItem value="closed">Closed</SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole('combobox', { name: 'Status' });
    expect(trigger).toBeInTheDocument();
    expect(screen.getByText('Choose a status')).toBeInTheDocument();
  });

  it('renders a disabled trigger', () => {
    render(
      <Select disabled>
        <SelectTrigger aria-label="Status">
          <SelectValue placeholder="Choose a status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="open">Open</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
  });
});
