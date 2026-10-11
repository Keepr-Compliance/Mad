import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedTabs } from './segmented-tabs';

const ITEMS = [
  { value: 'open', label: 'Open', count: 3 },
  { value: 'mine', label: 'Mine' },
  { value: 'closed', label: 'Closed' },
];

function Harness() {
  const [value, setValue] = React.useState('open');
  return <SegmentedTabs items={ITEMS} value={value} onValueChange={setValue} ariaLabel="Ticket views" panelId="panel" />;
}

describe('SegmentedTabs', () => {
  it('tab mode: only the selected tab is in the Tab order (roving tabindex)', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-controls', 'panel');
  });

  it('tab mode: arrows, Home and End move selection and focus', async () => {
    render(<Harness />);
    const tabs = () => screen.getAllByRole('tab');
    tabs()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tabs()[1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(tabs()[2]);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tabs()[0]);
    await userEvent.keyboard('{ArrowLeft}');
    expect(tabs()[2]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Home}');
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('link mode: a nav of links with aria-current on the selected one, no tab roles', () => {
    render(
      <SegmentedTabs
        ariaLabel="Project views"
        value="board"
        items={[
          { value: 'board', label: 'Board', href: '/p/board' },
          { value: 'list', label: 'List', href: '/p/list' },
        ]}
      />
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('navigation', { name: 'Project views' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'List' })).not.toHaveAttribute('aria-current');
  });
});
