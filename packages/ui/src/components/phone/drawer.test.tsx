import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer } from './drawer';

/** Controllable matchMedia: captures change listeners so a test can fire one. */
type Listener = (e: { matches: boolean }) => void;
let listeners: Array<{ query: string; fn: Listener }> = [];
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  listeners = [];
  window.matchMedia = jest.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, fn: Listener) => {
      listeners.push({ query, fn });
    },
    removeEventListener: (_type: string, fn: Listener) => {
      listeners = listeners.filter((l) => l.fn !== fn);
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function Harness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = React.useState(initialOpen);
  const menuRef = React.useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={menuRef} type="button" onClick={() => setOpen(true)}>
        Open menu
      </button>
      <Drawer open={open} onOpenChange={setOpen} returnFocusRef={menuRef} header={<span>Keepr</span>} footer={<button type="button">Sign out</button>}>
        <a href="/">Dashboard</a>
        <a href="/other">Other</a>
      </Drawer>
    </>
  );
}

describe('Drawer', () => {
  it('is a labelled modal dialog with the shells\' ids', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Main menu' });
    expect(dialog).toHaveAttribute('id', 'mobile-nav');
    expect(screen.getByTestId('mobile-nav-overlay')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    render(<Harness />);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('R2: closes when a link to the CURRENT page is tapped (no route change fires)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); // jsdom "navigation not implemented"
    render(<Harness />);
    expect(window.location.pathname).toBe('/');
    await userEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    errSpy.mockRestore();
  });

  it('does not close on a non-link click inside', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('Keepr'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('returns focus to returnFocusRef even when the trigger was never focused', async () => {
    render(<Harness initialOpen />);
    const menu = screen.getByRole('button', { name: 'Open menu', hidden: true });
    expect(document.activeElement).not.toBe(menu);
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(menu);
  });

  it('Tab stays inside the drawer (focus trap)', async () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 6; i += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('is modal: page content behind it is hidden from assistive tech while open', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open menu', hidden: true })).toBeInTheDocument();
  });

  it('R4: closes when the viewport crosses to the desktop breakpoint', () => {
    render(<Harness />);
    const desktop = listeners.filter((l) => l.query === '(min-width: 768px)');
    expect(desktop.length).toBeGreaterThan(0);
    act(() => desktop.forEach((l) => l.fn({ matches: true })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open on a media change that does not reach desktop', () => {
    render(<Harness />);
    act(() => listeners.forEach((l) => l.fn({ matches: false })));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('R7: inset-y-0 geometry with safe-area padding, never 100vh', () => {
    render(<Harness />);
    const cls = screen.getByRole('dialog').className;
    expect(cls).toContain('inset-y-0');
    expect(cls).toContain('pt-[env(safe-area-inset-top,0px)]');
    expect(cls).toContain('pb-[env(safe-area-inset-bottom,0px)]');
    expect(cls).not.toMatch(/h-screen|100vh/);
  });
});
