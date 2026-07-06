import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';

describe('Button', () => {
  it('renders a native button with its children', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toBeInTheDocument();
    expect(btn.tagName).toBe('BUTTON');
    // defaults to type="button" to avoid accidental form submits
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('applies variant + size classes', () => {
    render(
      <Button variant="destructive" size="lg">
        Delete
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toHaveClass('bg-destructive');
    expect(btn).toHaveClass('h-11');
  });

  it('fires onClick when enabled', async () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Click</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Click' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled and aria-busy while loading, and does not fire onClick', async () => {
    const onClick = jest.fn();
    render(
      <Button isLoading onClick={onClick}>
        Submit
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Submit' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders as a child element via asChild (Slot)', () => {
    render(
      <Button asChild variant="link">
        <a href="/next">Go</a>
      </Button>
    );
    const link = screen.getByRole('link', { name: 'Go' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/next');
    // variant styling is projected onto the anchor
    expect(link).toHaveClass('text-primary');
  });
});
