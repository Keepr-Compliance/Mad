import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileTopBar } from './mobile-top-bar';

describe('MobileTopBar', () => {
  it('menu button is 44px, controls the drawer, forwards its ref', async () => {
    const onOpenMenu = jest.fn();
    const ref = React.createRef<HTMLButtonElement>();
    render(<MobileTopBar ref={ref} qualifier="Broker" menuOpen={false} onOpenMenu={onOpenMenu} />);
    const btn = screen.getByRole('button', { name: 'Open menu' });
    expect(ref.current).toBe(btn);
    expect(btn).toHaveAttribute('aria-controls', 'mobile-nav');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveClass('h-11', 'w-11');
    await userEvent.click(btn);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Broker')).toBeInTheDocument();
  });

  it('hover styles are gated to hover-capable pointers', () => {
    render(<MobileTopBar qualifier="Admin" menuOpen={false} onOpenMenu={() => {}} />);
    const tokens = screen.getByRole('button', { name: 'Open menu' }).className.split(/\s+/);
    expect(tokens.filter((t) => t.startsWith('hover:'))).toEqual([]);
  });

  it('without a title the wordmark and qualifier render and no title node exists', () => {
    render(<MobileTopBar qualifier="Broker" menuOpen={false} onOpenMenu={() => {}} />);
    expect(screen.getByText('Broker')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-top-bar-title')).toBeNull();
  });

  it('a title replaces the wordmark and qualifier; leading still wins over it', () => {
    const { rerender } = render(
      <MobileTopBar qualifier="Broker" title="Users" menuOpen={false} onOpenMenu={() => {}} />
    );
    expect(screen.getByTestId('mobile-top-bar-title')).toHaveTextContent('Users');
    expect(screen.queryByText('Broker')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    rerender(
      <MobileTopBar
        qualifier="Broker"
        title="Users"
        leading={<span>Custom</span>}
        menuOpen={false}
        onOpenMenu={() => {}}
      />
    );
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-top-bar-title')).toBeNull();
  });
});
