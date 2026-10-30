import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MultiSelect, MultiSelectOptions, type MultiSelectOption } from './multi-select';
import { selectAllValues } from './select-all';
import { BottomSheet } from '../phone/bottom-sheet';
import { FilterSelectButton } from '../phone/filter-select-button';
import { Dialog, DialogContent, DialogTitle } from '../dialog';

const OPTIONS: MultiSelectOption[] = [
  { value: 'failed', label: 'Failed', count: 12 },
  { value: 'ok', label: 'Succeeded', count: 0 },
  { value: 'stalled', label: 'Stalled' },
];

function Controlled({
  initial = [],
  spy,
  bulkActions,
}: {
  initial?: string[];
  spy?: (next: string[]) => void;
  bulkActions?: boolean;
}) {
  const [selected, setSelected] = React.useState<string[]>(initial);
  return (
    <MultiSelectOptions
      options={OPTIONS}
      selected={selected}
      bulkActions={bulkActions}
      onChange={(next) => {
        spy?.(next);
        setSelected(next);
      }}
    />
  );
}

const box = (name: string) => screen.getByRole('checkbox', { name });
const row = (name: string) => box(name).closest('[data-slot="multi-select-option"]') as HTMLElement;

describe('MultiSelectOptions', () => {
  it("names each checkbox EXACTLY by its label, with the count outside the name", () => {
    render(<Controlled />);
    expect(box('Failed')).toBeInTheDocument();
    expect(box('Succeeded')).toBeInTheDocument();
    expect(within(row('Failed')).getByText('12')).toBeInTheDocument();
  });

  it('renders a count of 0 as "0", and no count element when count is absent', () => {
    render(<Controlled />);
    expect(within(row('Succeeded')).getByText('0')).toBeInTheDocument();
    expect(row('Stalled').textContent).toBe('Stalled');
  });

  it('clicking the option text (a span inside the label) toggles it', () => {
    const spy = jest.fn();
    render(<Controlled spy={spy} />);
    fireEvent.click(screen.getByText('Failed', { selector: 'label span' }));
    expect(spy).toHaveBeenLastCalledWith(['failed']);
    expect(box('Failed')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByLabelText('Stalled'));
    expect(spy).toHaveBeenLastCalledWith(['failed', 'stalled']);
    fireEvent.click(box('Failed'));
    expect(spy).toHaveBeenLastCalledWith(['stalled']);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('Select all adds every option once, keeping what was selected and adding no duplicates', () => {
    const spy = jest.fn();
    render(<Controlled initial={['ok']} spy={spy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(spy).toHaveBeenLastCalledWith(['ok', 'failed', 'stalled']);
    expect(selectAllValues(OPTIONS, ['failed', 'ok'])).toEqual(['failed', 'ok', 'stalled']);
  });

  it('Clear all empties the selection', () => {
    const spy = jest.fn();
    render(<Controlled initial={['ok', 'failed']} spy={spy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(spy).toHaveBeenLastCalledWith([]);
    expect(box('Failed')).toHaveAttribute('aria-checked', 'false');
  });

  it('shows both bulk rows by default and hides both with bulkActions={false}', () => {
    const { unmount } = render(<Controlled />);
    expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    unmount();
    render(<Controlled bulkActions={false} />);
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('marks ONLY checked rows: data-state and bg-primary-50', () => {
    render(<Controlled initial={['failed']} />);
    expect(row('Failed')).toHaveAttribute('data-state', 'checked');
    expect(row('Failed').className).toContain('bg-primary-50');
    expect(row('Succeeded')).toHaveAttribute('data-state', 'unchecked');
    expect(row('Succeeded').className).not.toContain('bg-primary-50');
  });

  it('is purely controlled: a no-op onChange leaves every check unchanged', () => {
    const onChange = jest.fn();
    render(<MultiSelectOptions options={OPTIONS} selected={['failed']} onChange={onChange} />);
    fireEvent.click(box('Succeeded'));
    fireEvent.click(box('Failed'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(box('Succeeded')).toHaveAttribute('aria-checked', 'false');
    expect(box('Failed')).toHaveAttribute('aria-checked', 'true');
  });
});

function Desktop({ initial = [], spy }: { initial?: string[]; spy?: (next: string[]) => void }) {
  const [selected, setSelected] = React.useState<string[]>(initial);
  return (
    <div>
      <MultiSelect
        label="Outcome"
        options={OPTIONS}
        selected={selected}
        onChange={(next) => {
          spy?.(next);
          setSelected(next);
        }}
      />
      <p>elsewhere</p>
    </div>
  );
}

const trigger = () => screen.getAllByRole('button', { name: /^Outcome/ });

describe('MultiSelect (desktop)', () => {
  it('reads "Label" with nothing selected and "Label (n)" with n selected', () => {
    const { unmount } = render(<Desktop />);
    expect(trigger()[0]).toHaveAccessibleName('Outcome');
    unmount();
    render(<Desktop initial={['failed', 'ok']} />);
    expect(trigger()[0]).toHaveAccessibleName('Outcome (2)');
  });

  it('the clear X is a SIBLING button whose name does not start with the label', () => {
    const spy = jest.fn();
    render(<Desktop initial={['failed']} spy={spy} />);
    expect(trigger()).toHaveLength(1);
    const clear = screen.getByRole('button', { name: 'Clear Outcome filter' });
    expect(trigger()[0].contains(clear)).toBe(false);
    fireEvent.click(clear);
    expect(spy).toHaveBeenLastCalledWith([]);
    expect(trigger()[0]).toHaveAccessibleName('Outcome');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('opens on click, toggles through the list, and updates the trigger', () => {
    render(<Desktop />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(trigger()[0]);
    expect(trigger()[0]).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByText('Stalled', { selector: 'label span' }));
    expect(trigger()[0]).toHaveAccessibleName('Outcome (1)');
    expect(box('Stalled')).toHaveAttribute('aria-checked', 'true');
  });

  it('closes on a click outside, but not on a click inside', () => {
    render(<Desktop />);
    fireEvent.click(trigger()[0]);
    fireEvent.mouseDown(box('Failed'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('clicking the trigger a second time closes the popover (mousedown then click, as a browser sends)', () => {
    render(<Desktop />);
    const press = () => {
      fireEvent.mouseDown(trigger()[0]);
      fireEvent.click(trigger()[0]);
    };
    press();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    press();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(trigger()[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('a mousedown on the clear X (inside the container, outside the popover) leaves the popover open', () => {
    render(<Desktop initial={['failed']} />);
    fireEvent.click(trigger()[0]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Clear Outcome filter' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });

  it('closes on Escape', () => {
    render(<Desktop />);
    fireEvent.click(trigger()[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('C7 Escape inside a kit Dialog closes the panel, not the dialog, and returns focus to the trigger (BACKLOG-4032)', () => {
    function InDialog() {
      const [dlg, setDlg] = React.useState(true);
      return (
        <>
          <span data-testid="dlg">{dlg ? 'dlg-open' : 'dlg-closed'}</span>
          <Dialog open={dlg} onOpenChange={setDlg}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Edit</DialogTitle>
              <MultiSelect label="Outcome" options={OPTIONS} selected={[]} onChange={() => {}} />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<InDialog />);
    fireEvent.click(trigger()[0]);
    fireEvent.keyDown(box('Failed'), { key: 'Escape' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-open');
    expect(document.activeElement).toBe(trigger()[0]);
    // Closed: Escape is the dialog's again (no leaked listener).
    fireEvent.keyDown(trigger()[0], { key: 'Escape' });
    expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-closed');
  });
});

/**
 * The phone recipe from the README: FilterSelectButton + BottomSheet +
 * MultiSelectOptions (bulkActions off, Select all / Clear in the sheet header),
 * holding a PENDING selection that only the footer button applies.
 */
function PhoneRecipe({ onApply }: { onApply: (v: string[]) => void }) {
  const [applied, setApplied] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState(false);
  const headerButton = 'min-h-11 px-2 text-sm font-semibold text-primary-700';
  return (
    <>
      <FilterSelectButton
        label="Outcome"
        value={applied.length > 0 ? `${applied.length} selected` : 'All'}
        active={applied.length > 0}
        expanded={open}
        onClick={() => {
          setPending(applied);
          setOpen(true);
        }}
      />
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title="Outcome"
        headerAction={
          <>
            <button type="button" className={headerButton} onClick={() => setPending(selectAllValues(OPTIONS, pending))}>
              Select all
            </button>
            <button type="button" className={headerButton} onClick={() => setPending([])}>
              Clear
            </button>
          </>
        }
        primaryAction={
          <button
            type="button"
            onClick={() => {
              setApplied(pending);
              onApply(pending);
              setOpen(false);
            }}
          >
            Apply
          </button>
        }
      >
        <MultiSelectOptions options={OPTIONS} selected={pending} onChange={setPending} bulkActions={false} />
      </BottomSheet>
    </>
  );
}

describe('MultiSelectOptions phone recipe', () => {
  it('holds a pending selection until Apply, then the button reads "n selected"', () => {
    const onApply = jest.fn();
    render(<PhoneRecipe onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /Outcome/ }));
    fireEvent.click(box('Failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(box('Stalled')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(box('Succeeded'));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(['ok']);
    expect(screen.getByRole('button', { name: /Outcome/ })).toHaveTextContent('1 selected');
  });
});
