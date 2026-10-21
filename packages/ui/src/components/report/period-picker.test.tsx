import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PeriodPicker } from './period-picker';

type P = 'week' | 'month' | 'custom';
const OPTIONS = [
  { value: 'week' as const, label: 'Last 7 days' },
  { value: 'month' as const, label: 'Last 30 days' },
  { value: 'custom' as const, label: 'Custom range' },
];

function Harness({ spy, initial = 'custom' }: { spy: (...a: unknown[]) => void; initial?: P }) {
  const [state, setState] = React.useState<{ value: P; from?: string; to?: string }>({
    value: initial,
    from: '2026-09-01',
    to: '2026-09-30',
  });
  return (
    <PeriodPicker<P>
      options={OPTIONS}
      value={state.value}
      customKey="custom"
      from={state.from}
      to={state.to}
      onChange={(value, from, to) => {
        spy(value, from, to);
        setState({ value, from, to });
      }}
    />
  );
}

describe('PeriodPicker', () => {
  it('shows From / To only while the custom period is selected', () => {
    const spy = jest.fn();
    render(<Harness spy={spy} initial="week" />);
    expect(screen.queryByLabelText('From')).toBeNull();
    expect(screen.queryByLabelText('To')).toBeNull();
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
    expect(spy).toHaveBeenLastCalledWith('custom', '2026-09-01', '2026-09-30');
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-09-30');
  });

  it('never shows the date inputs without a customKey', () => {
    render(<PeriodPicker options={OPTIONS} value="custom" onChange={() => {}} />);
    expect(screen.queryByLabelText('From')).toBeNull();
  });

  it('lists the options and reports a select change once', () => {
    const spy = jest.fn();
    render(<Harness spy={spy} initial="week" />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Last 7 days', 'Last 30 days', 'Custom range']);
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'month' } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith('month', '2026-09-01', '2026-09-30');
  });

  it('commits a complete date once, and not again on blur', () => {
    const spy = jest.fn();
    render(<Harness spy={spy} />);
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '2026-08-15' } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith('custom', '2026-08-15', '2026-09-30');
    fireEvent.blur(from);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT report the empty value a half-typed date produces; commits it on blur', () => {
    const spy = jest.fn();
    render(<Harness spy={spy} />);
    const to = screen.getByLabelText('To');
    fireEvent.change(to, { target: { value: '' } });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.blur(to);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith('custom', '2026-09-01', undefined);
  });

  it('shows a new from / to when the parent changes them while custom stays selected', () => {
    const props = { options: OPTIONS, value: 'custom' as const, customKey: 'custom' as const, onChange: () => {} };
    const { rerender } = render(<PeriodPicker<P> {...props} from="2026-09-01" to="2026-09-30" />);
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    rerender(<PeriodPicker<P> {...props} from="2026-07-04" to="2026-08-20" />);
    expect(screen.getByLabelText('From')).toHaveValue('2026-07-04');
    expect(screen.getByLabelText('To')).toHaveValue('2026-08-20');
    rerender(<PeriodPicker<P> {...props} />);
    expect(screen.getByLabelText('From')).toHaveValue('');
    expect(screen.getByLabelText('To')).toHaveValue('');
  });
});
