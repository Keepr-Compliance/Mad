import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmationDialog } from './confirmation-dialog';

/** Rendered with controlled open={true} — no trigger click, which is the
 *  reliable pattern for Radix dialogs under jsdom. */
function setup(props: Partial<React.ComponentProps<typeof ConfirmationDialog>> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <ConfirmationDialog
      open
      title="Delete transaction?"
      description="This cannot be undone."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  );
  return { onConfirm, onCancel };
}

describe('ConfirmationDialog', () => {
  it('exposes an alertdialog with an accessible name + description', () => {
    setup();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAccessibleName('Delete transaction?');
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
  });

  it('renders confirm + cancel actions with default labels', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('honors custom labels', () => {
    setup({ confirmLabel: 'Delete', cancelLabel: 'Keep' });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
  });

  it('calls onConfirm / onCancel on the respective buttons', async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('applies destructive styling to the confirm button when isDestructive', () => {
    setup({ isDestructive: true, confirmLabel: 'Delete' });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass(
      'bg-destructive'
    );
  });

  it('disables both buttons while loading', () => {
    setup({ loading: true });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
