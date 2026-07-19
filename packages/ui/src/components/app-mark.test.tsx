import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { AppMark } from './app-mark';

describe('AppMark', () => {
  it('renders an svg with the app-mark test id', () => {
    render(<AppMark />);
    const mark = screen.getByTestId('app-mark');
    expect(mark).toBeInTheDocument();
    expect(mark.tagName.toLowerCase()).toBe('svg');
  });

  it('defaults to 32px square and respects a custom size', () => {
    const { rerender } = render(<AppMark />);
    let mark = screen.getByTestId('app-mark');
    expect(mark).toHaveAttribute('width', '32');
    expect(mark).toHaveAttribute('height', '32');

    rerender(<AppMark size={48} />);
    mark = screen.getByTestId('app-mark');
    expect(mark).toHaveAttribute('width', '48');
    expect(mark).toHaveAttribute('height', '48');
  });

  it('applies a custom className', () => {
    render(<AppMark className="mr-2" />);
    expect(screen.getByTestId('app-mark')).toHaveClass('mr-2');
  });

  it('renders the indigo gradient + gold accent dot', () => {
    const { container } = render(<AppMark />);
    const colors = Array.from(container.querySelectorAll('stop')).map((s) =>
      s.getAttribute('stop-color')
    );
    expect(colors).toContain('#4F46E5');
    expect(colors).toContain('#6D5DF0');

    const tspan = container.querySelector('tspan');
    expect(tspan).toHaveAttribute('fill', '#F5A524');
    expect(tspan?.textContent).toBe('.');
  });

  it('gives each instance a unique gradient id (no collision)', () => {
    const { container } = render(
      <>
        <AppMark />
        <AppMark />
      </>
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) =>
      g.getAttribute('id')
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toEqual(ids[1]);
  });

  it('is decorative by default and titled when a title is given', () => {
    const { rerender } = render(<AppMark />);
    let mark = screen.getByTestId('app-mark');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).not.toHaveAttribute('role');

    rerender(<AppMark title="Keepr" />);
    mark = screen.getByTestId('app-mark');
    expect(mark).toHaveAttribute('role', 'img');
    expect(mark).not.toHaveAttribute('aria-hidden');
    expect(screen.getByText('Keepr')).toBeInTheDocument();
  });
});
