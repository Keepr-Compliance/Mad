import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { StatCardProps as DesignSystemStatCardProps } from '@keepr/design-system';
import { StatCard, type StatCardProps, type StatCardHue } from './stat-card';

/**
 * R7: a TRUE superset of the design-system StatCard. This assignment is a
 * compile-time check — it is enforced by `npm run type-check -w @keepr/ui`
 * (tsc), not by jest (ts-jest with isolatedModules does not type-check).
 */
export function asKitProps(props: DesignSystemStatCardProps): StatCardProps {
  return props;
}

const valueEl = (container: HTMLElement) => container.querySelector('[data-tile-value="x"]') as HTMLElement;

describe('StatCard', () => {
  it('accepts design-system props unchanged', () => {
    const ds: DesignSystemStatCardProps = { label: 'Users', value: 4, trend: '+2', trendDirection: 'up', hue: 'green' };
    render(<StatCard {...asKitProps(ds)} />);
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.getByText('+2').className).toContain('text-green-600');
  });

  it('is a plain card, not a button, without onClick', () => {
    render(<StatCard label="Failed" value={3} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is a toggle button with onClick: aria-pressed follows pressed', () => {
    const onClick = jest.fn();
    const { rerender } = render(<StatCard label="Stalled now" value={2} onClick={onClick} />);
    const button = screen.getByRole('button', { name: /Stalled now/ });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<StatCard label="Stalled now" value={2} onClick={onClick} pressed />);
    expect(screen.getByRole('button', { name: /Stalled now/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each([
    [3, true],
    [0, false],
  ])('critical tone with value %p -> red: %p', (value, red) => {
    const { container } = render(
      <StatCard label="Failed" value={value} tone="critical" valueProps={{ 'data-tile-value': 'x' }} />
    );
    expect(valueEl(container).className.includes('text-red-700')).toBe(red);
    expect(valueEl(container).getAttribute('data-tone')).toBe(red ? 'critical' : null);
  });

  it('critical tone never reds a value that is not a number', () => {
    const { container, rerender } = render(
      <StatCard label="Failed" value="3" tone="critical" valueProps={{ 'data-tile-value': 'x' }} />
    );
    expect(valueEl(container).className).not.toContain('text-red-700');
    rerender(<StatCard label="Failed" value={<b>3</b>} tone="critical" valueProps={{ 'data-tile-value': 'x' }} />);
    expect(valueEl(container).className).not.toContain('text-red-700');
  });

  it('a default-tone card never goes red', () => {
    const { container } = render(<StatCard label="Done" value={9} valueProps={{ 'data-tile-value': 'x' }} />);
    expect(valueEl(container).className).not.toContain('text-red-700');
  });

  it('puts valueProps on the value element and data-* on the card', () => {
    const { container } = render(
      <StatCard label="Failed" value={7} data-tile="failed" valueProps={{ 'data-tile-value': 'x', className: 'extra' }} />
    );
    expect(valueEl(container).textContent).toBe('7');
    expect(valueEl(container).className).toContain('extra');
    expect(container.querySelector('[data-tile="failed"]')).toHaveAttribute('data-slot', 'stat-card');
  });

  it('renders subtitle and footer', () => {
    render(<StatCard label="L" value={1} subtitle="of 40 attempts" footer={<span>more</span>} />);
    expect(screen.getByText('of 40 attempts')).toBeInTheDocument();
    expect(screen.getByText('more')).toBeInTheDocument();
  });

  const HUES: StatCardHue[] = ['primary', 'blue', 'green', 'yellow', 'red', 'gray', 'indigo', 'orange', 'purple'];
  it.each(HUES)('hue %s colours the icon tile', (hue) => {
    render(<StatCard label="L" value={1} hue={hue} icon={<svg data-testid="icon" />} />);
    expect(screen.getByTestId('icon').parentElement?.className).toContain(`bg-${hue}-50`);
  });

  it.each([
    ['up', 'text-green-600'],
    ['down', 'text-red-600'],
    ['neutral', 'text-gray-500'],
  ] as const)('trendDirection %s', (dir, cls) => {
    render(<StatCard label="L" value={1} trend="+1" trendDirection={dir} />);
    expect(screen.getByText('+1').className).toContain(cls);
  });
});
