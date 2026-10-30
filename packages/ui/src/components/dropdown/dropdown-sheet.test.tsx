import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dropdown } from './dropdown';
import { DropdownOptions } from './dropdown-options';
import type { DropdownOption } from './types';
import { BottomSheet } from '../phone/bottom-sheet';
import { FilterSelectButton } from '../phone/filter-select-button';
import { Dialog, DialogContent, DialogTitle } from '../dialog';

/**
 * BACKLOG-4032 slice 2: Dropdown `presentation="sheet"` and the filter-bar
 * recipe. Ids S1-S8, T-R match the plan and SR review (R2, R3).
 *
 * Focus restore runs in Radix FocusScope's setTimeout(0), so every focus
 * assertion after a close flushes timers first (`settle`).
 */
const ROLES: DropdownOption[] = [
  { value: 'admin', label: 'Admin', description: 'Manages users and billing' },
  { value: 'agent', label: 'Agent', description: 'Sees own transactions' },
  { value: 'billing', label: 'Billing', disabled: true, hint: 'Already billing contact' },
  { value: 'viewer', label: 'Viewer', description: 'Read only' },
];

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

function SheetField({ onChange, initial = 'agent' }: { onChange: (v: string) => void; initial?: string | null }) {
  const [value, setValue] = React.useState<string | null>(initial);
  return (
    <Dropdown
      label="Role"
      presentation="sheet"
      options={ROLES}
      value={value}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
    />
  );
}

// hidden: Radix marks the page aria-hidden while the sheet is open.
const trigger = () => screen.getByRole('button', { name: /^Role/, hidden: true });
const sheet = () => screen.queryByRole('dialog', { name: 'Role' });

describe('Dropdown presentation="sheet"', () => {
  it('S1 opens a sheet named by the label; focus on the search; no inline panel; aria-haspopup=dialog', async () => {
    const { container } = render(<SheetField onChange={jest.fn()} />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(container.querySelector('[data-slot="dropdown"]')).toHaveAttribute('data-presentation', 'sheet');
    await userEvent.click(trigger());
    await settle();
    expect(sheet()).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search Role' }));
    expect(document.querySelector('[data-slot="dropdown-panel"]')).toBeNull();
    // Comfortable rows inside the sheet.
    expect(within(sheet()!).getByRole('option', { name: /Admin/ }).className).toContain('min-h-12');
  });

  it('S2 a tap on a row commits once and closes; no footer (userEvent: pointerdown first)', async () => {
    const onChange = jest.fn();
    render(<SheetField onChange={onChange} />);
    await userEvent.click(trigger());
    expect(document.querySelector('[data-slot="bottom-sheet-footer"]')).toBeNull();
    await userEvent.click(within(sheet()!).getByRole('option', { name: /Viewer/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('viewer');
    expect(sheet()).toBeNull();
    expect(trigger()).toHaveAccessibleName(/Role\s+Viewer/);
  });

  it('S3 Enter on the active row picks and closes', async () => {
    const onChange = jest.fn();
    render(<SheetField onChange={onChange} />);
    await userEvent.click(trigger());
    await settle();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it('S4 focus returns to the trigger after a pick, Escape and Close (opened by fireEvent, trigger never focused)', async () => {
    const onChange = jest.fn();
    render(<SheetField onChange={onChange} />);

    fireEvent.click(trigger());
    await settle();
    expect(document.activeElement).not.toBe(trigger());
    fireEvent.click(within(sheet()!).getByRole('option', { name: /Admin/ }));
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    (document.activeElement as HTMLElement).blur();
    fireEvent.click(trigger());
    await settle();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    (document.activeElement as HTMLElement).blur();
    fireEvent.click(trigger());
    await settle();
    fireEvent.click(within(sheet()!).getByRole('button', { name: 'Close' }));
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('S5 inside a kit Dialog: one Escape with search text closes only the sheet; focus back on the trigger', async () => {
    const onChange = jest.fn();
    function InDialog() {
      const [open, setOpen] = React.useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Outer</DialogTitle>
            <SheetField onChange={onChange} />
          </DialogContent>
        </Dialog>
      );
    }
    render(<InDialog />);
    await userEvent.click(trigger());
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search Role' }));
    await userEvent.keyboard('ad');
    expect(screen.getByRole('combobox', { name: 'Search Role' })).toHaveValue('ad');
    await userEvent.keyboard('{Escape}');
    await settle();
    expect(sheet()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('S6 a tap on a disabled row does nothing: sheet stays open', async () => {
    const onChange = jest.fn();
    render(<SheetField onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(within(sheet()!).getByRole('option', { name: /Billing/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(sheet()).toBeInTheDocument();
  });

  it('S8 popover (the default) renders no sheet', async () => {
    render(<Dropdown label="Role" options={ROLES} value="agent" onChange={jest.fn()} />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
    await userEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-slot="dropdown-panel"]')).not.toBeNull();
  });
});

describe('DropdownOptions description size', () => {
  it('S7 comfortable descriptions are text-sm; default stays text-xs; hint stays text-xs', () => {
    const { unmount } = render(
      <DropdownOptions options={ROLES} value={null} onSelect={jest.fn()} ariaLabel="Role" size="comfortable" />
    );
    expect(screen.getByText('Manages users and billing')).toHaveClass('text-sm');
    expect(screen.getByText('Manages users and billing')).not.toHaveClass('text-xs');
    expect(screen.getByText('Already billing contact')).toHaveClass('text-xs');
    unmount();
    render(<DropdownOptions options={ROLES} value={null} onSelect={jest.fn()} ariaLabel="Role" />);
    expect(screen.getByText('Manages users and billing')).toHaveClass('text-xs');
  });
});

describe('Filter-bar recipe (README "Phone")', () => {
  function Recipe() {
    const [open, setOpen] = React.useState(false);
    const [value, setValue] = React.useState<string | null>('agent');
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const current = ROLES.find((o) => o.value === value)?.label ?? 'All roles';
    return (
      <>
        <FilterSelectButton ref={buttonRef} label="Role" value={current} expanded={open} onClick={() => setOpen(true)} />
        <BottomSheet open={open} onOpenChange={setOpen} title="Role" returnFocusRef={buttonRef}>
          <DropdownOptions
            options={ROLES}
            value={value}
            ariaLabel="Role"
            size="comfortable"
            autoFocus
            onSelect={(v) => {
              setValue(v);
              setOpen(false);
            }}
          />
        </BottomSheet>
      </>
    );
  }

  it('T-R open, pick, the button shows the value and gets focus back', async () => {
    render(<Recipe />);
    fireEvent.click(screen.getByRole('button', { name: 'Role: Agent' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search Role' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Role' })).getByRole('option', { name: /Viewer/ }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    const button = screen.getByRole('button', { name: 'Role: Viewer' });
    expect(document.activeElement).toBe(button);
  });
});
