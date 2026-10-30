import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

/**
 * BACKLOG-4032 B1: focus on close. Radix restores focus in a setTimeout(0),
 * so each case flushes timers before reading activeElement.
 */
describe('BottomSheet focus on close', () => {
  async function settle() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  function Opener({ withRef }: { withRef: boolean }) {
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={ref} type="button" onClick={() => setOpen(true)}>
          Open sheet
        </button>
        <BottomSheet open={open} onOpenChange={setOpen} title="Pick" returnFocusRef={withRef ? ref : undefined}>
          {/* Like the live sheets, the body focuses something itself on open. */}
          <input aria-label="Search" autoFocus />
        </BottomSheet>
      </>
    );
  }

  it('returns focus to returnFocusRef even when the opener was never focused (fireEvent click)', async () => {
    render(<Opener withRef />);
    fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }));
    await settle();
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Open sheet', hidden: true }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open sheet' }));
  });

  it('without returnFocusRef, returns focus to the element focused at open (userEvent click)', async () => {
    render(<Opener withRef={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open sheet' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search' }));
    await userEvent.keyboard('{Escape}');
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open sheet' }));
  });
});
