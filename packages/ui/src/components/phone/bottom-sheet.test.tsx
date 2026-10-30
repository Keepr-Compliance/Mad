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

/** BACKLOG-4032 fix-up: the grab handle drags the sheet closed. */
describe('BottomSheet drag to close', () => {
  // jsdom has no PointerEvent: without this, fireEvent drops clientY/pointerId.
  beforeAll(() => {
    if (typeof window.PointerEvent === 'undefined') {
      class PE extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
          this.pointerType = init.pointerType ?? 'touch';
        }
      }
      (window as unknown as { PointerEvent: unknown }).PointerEvent = PE;
    }
  });

  async function settle() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  function Opener({ fixedHeight = false }: { fixedHeight?: boolean }) {
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={ref} type="button" onClick={() => setOpen(true)}>
          Open sheet
        </button>
        <BottomSheet open={open} onOpenChange={setOpen} title="Pick" returnFocusRef={ref} fixedHeight={fixedHeight}>
          <input aria-label="Search" autoFocus />
        </BottomSheet>
      </>
    );
  }

  async function openSheet(fixedHeight = false) {
    render(<Opener fixedHeight={fixedHeight} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Pick' });
    // jsdom has no layout: give the sheet a 400px height for the 25% threshold.
    dialog.getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
    const handle = document.querySelector('[data-slot="bottom-sheet-handle"]') as HTMLElement;
    return { dialog, handle };
  }

  function drag(el: HTMLElement, dy: number) {
    fireEvent.pointerDown(el, { pointerId: 1, clientY: 100, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: 100 + dy });
    return () => fireEvent.pointerUp(el, { pointerId: 1, clientY: 100 + dy });
  }

  it('moves the sheet with the pointer while dragging down', async () => {
    const { dialog, handle } = await openSheet();
    drag(handle, 60);
    expect(dialog.style.transform).toBe('translateY(60px)');
  });

  it('closes past 25% of the height and returns focus to the opener', async () => {
    const { handle } = await openSheet();
    const release = drag(handle, 150);
    // Slow drag (150px over 400ms = 0.375px/ms) so the flick rule cannot be what closes it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    release();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open sheet' }));
  });

  it('snaps back and stays open below the threshold', async () => {
    const { dialog, handle } = await openSheet();
    drag(handle, 20)();
    await settle();
    expect(screen.getByRole('dialog', { name: 'Pick' })).toBe(dialog);
    expect(dialog.style.transform).toBe('');
  });

  it('closes on a fast flick shorter than the distance threshold', async () => {
    const { handle } = await openSheet();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 150 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 150 });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an upward drag does not move or close the sheet', async () => {
    const { dialog, handle } = await openSheet();
    drag(handle, -200)();
    await settle();
    expect(screen.getByRole('dialog', { name: 'Pick' })).toBe(dialog);
    expect(dialog.style.transform).toBe('');
  });

  it('does not start a drag from the Close button', async () => {
    const { dialog } = await openSheet();
    drag(screen.getByRole('button', { name: 'Close' }), 150);
    expect(dialog.style.transform).toBe('');
  });

  it('fixedHeight sets a constant height class; default sheets size to content', async () => {
    const a = await openSheet(true);
    expect(a.dialog.className).toContain('h-[min(80vh,40rem)]');
    expect(a.dialog.className).toContain('supports-[height:100dvh]:h-[min(80dvh,40rem)]');
  });
});
