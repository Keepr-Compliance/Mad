import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { Wordmark, KEEPR_DOT_COLOR } from './wordmark';

describe('Wordmark', () => {
  it('renders the full "Keepr." text', () => {
    render(<Wordmark />);
    // The visible text content is "Keepr." (letters + dot).
    expect(screen.getByTestId('wordmark')).toHaveTextContent('Keepr.');
  });

  it('colors ONLY the trailing period gold (#F5A524)', () => {
    const { container } = render(<Wordmark />);
    const root = screen.getByTestId('wordmark');
    // The root span must NOT carry the gold color — the letters stay inherited.
    expect(root).not.toHaveStyle({ color: KEEPR_DOT_COLOR });

    // The inner span is the dot, and it is the gold accent.
    const dot = container.querySelector('span[data-testid="wordmark"] > span');
    expect(dot).not.toBeNull();
    expect(dot).toHaveTextContent('.');
    expect(dot).toHaveStyle({ color: KEEPR_DOT_COLOR });
  });

  it('applies a custom className to the root', () => {
    render(<Wordmark className="text-xl font-bold" />);
    const root = screen.getByTestId('wordmark');
    expect(root).toHaveClass('text-xl');
    expect(root).toHaveClass('font-bold');
  });

  it('exposes the brand gold constant', () => {
    expect(KEEPR_DOT_COLOR).toBe('#F5A524');
  });
});
