import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BottomSheet } from './bottom-sheet';

function Harness() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
    <button type="button">Page behind</button>
    <BottomSheet open={open} onOpenChange={setOpen} title="Filters" primaryAction={<button type="button">Apply</button>}>
      <p>Body</p>
    </BottomSheet>
    </>
  );
}

describe('BottomSheet', () => {
  it('is a modal dialog named by its title', () => {
    render(<Harness />);
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  });

  it('is modal: the page behind is hidden from assistive tech while open', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Page behind' })).toBeNull();
  });

  it('closes on Escape and on the Close button', async () => {
    const { unmount } = render(<Harness />);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the primary action outside the scrolling body', () => {
    render(<Harness />);
    const apply = screen.getByRole('button', { name: 'Apply' });
    const body = screen.getByText('Body').closest('[data-slot="bottom-sheet-body"]');
    expect(body).not.toBeNull();
    expect(body!.contains(apply)).toBe(false);
  });

  it('R7: caps height at 90dvh with a 90vh fallback', () => {
    render(<Harness />);
    const cls = screen.getByRole('dialog').className;
    expect(cls).toContain('max-h-[90vh]');
    expect(cls).toContain('supports-[height:100dvh]:max-h-[90dvh]');
  });
});
