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

  describe('fill', () => {
    const TWO = [
      { value: 'choose', label: 'Choose a user' },
      { value: 'invite', label: 'Invite new person' },
    ];

    it('fill: container is a grid with one equal column per item and items are full-width', () => {
      render(<SegmentedTabs items={TWO} value="choose" ariaLabel="Who" fill />);
      const list = screen.getByRole('tablist');
      expect(list.className).toContain('grid');
      expect(list.className).not.toMatch(/(^|\s)flex(\s|$)/);
      expect(list.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
      for (const tab of screen.getAllByRole('tab')) {
        expect(tab.className).toContain('w-full');
        expect(tab.className).toContain('justify-center');
      }
    });

    it('fill: link mode gets the same grid and full-width links', () => {
      render(
        <SegmentedTabs
          ariaLabel="Views"
          value="a"
          fill
          items={[
            { value: 'a', label: 'A', href: '/a' },
            { value: 'b', label: 'B', href: '/b' },
            { value: 'c', label: 'C', href: '/c' },
          ]}
        />
      );
      const nav = screen.getByRole('navigation', { name: 'Views' });
      expect(nav.className).toContain('grid');
      expect(nav.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
      for (const a of screen.getAllByRole('link')) expect(a.className).toContain('w-full');
    });

    it('without fill: the scrolling strip classes are unchanged', () => {
      render(<SegmentedTabs items={TWO} value="choose" ariaLabel="Who" />);
      const list = screen.getByRole('tablist');
      expect(list.className).toBe('flex gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-1');
      expect(list.getAttribute('style')).toBeNull();
      const first = screen.getAllByRole('tab')[0];
      expect(first.className).toContain('shrink-0');
      expect(first.className).not.toContain('w-full');
    });
  });
});
