import * as React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { useClickOutside } from './use-click-outside';

function Box({ cb, enabled }: { cb: () => void; enabled?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useClickOutside(ref, cb, enabled);
  return (
    <div>
      <div ref={ref}>
        <button type="button">inside</button>
      </div>
      <button type="button">outside</button>
    </div>
  );
}

describe('useClickOutside', () => {
  it('fires on a mousedown outside, not inside', () => {
    const cb = jest.fn();
    render(<Box cb={cb} />);
    fireEvent.mouseDown(screen.getByText('inside'));
    expect(cb).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled', () => {
    const cb = jest.fn();
    render(<Box cb={cb} enabled={false} />);
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount', () => {
    const cb = jest.fn();
    const { unmount } = render(<Box cb={cb} />);
    unmount();
    fireEvent.mouseDown(document.body);
    expect(cb).not.toHaveBeenCalled();
  });
});
