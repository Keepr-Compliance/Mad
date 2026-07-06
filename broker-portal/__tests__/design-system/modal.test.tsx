/**
 * Modal + ConfirmationDialog behavior (BACKLOG-1811)
 *
 * Covers the dismissal contract that the adversarial review hardened:
 * Escape/backdrop/X all close a dismissible modal, and ALL of them are
 * blocked when dismissible={false} (e.g. while a server action is in
 * flight). Also covers the short-viewport scroll fix.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConfirmationDialog, Modal } from '@keepr/design-system';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal open={false} onClose={jest.fn()}>hidden</Modal>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a dialog with the title header and scrollable panel', () => {
    render(
      <Modal open onClose={jest.fn()} title="Invite user">body</Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.className).toContain('max-h-[90vh]');
    expect(dialog.className).toContain('overflow-y-auto');
    expect(screen.getByText('Invite user').className).toContain('text-lg font-semibold');
  });

  it('closes on Escape, backdrop click, and the header X when dismissible', () => {
    const onClose = jest.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="T">body</Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector('[aria-hidden="true"]') as Element);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('blocks Escape, backdrop, and the header X when dismissible={false}', () => {
    const onClose = jest.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="T" dismissible={false}>body</Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(container.querySelector('[aria-hidden="true"]') as Element);
    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect(closeButton).toBeDisabled();
    fireEvent.click(closeButton);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the Escape listener on unmount', () => {
    const onClose = jest.fn();
    const { unmount } = render(<Modal open onClose={onClose}>body</Modal>);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ConfirmationDialog', () => {
  const baseProps = {
    open: true,
    title: 'Remove user',
    description: 'This cannot be undone.',
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };

  it('fires onConfirm and onCancel from the footer buttons', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <ConfirmationDialog {...baseProps} onConfirm={onConfirm} onCancel={onCancel} confirmLabel="Remove" cancelLabel="Keep" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('isDestructive renders the red confirm and warning icon treatment', () => {
    const { container } = render(<ConfirmationDialog {...baseProps} isDestructive confirmLabel="Delete" />);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-red-600');
    expect(container.querySelector('.bg-red-100 svg')).not.toBeNull();
  });

  it('loading disables both buttons and blocks Escape dismissal', () => {
    const onCancel = jest.fn();
    render(<ConfirmationDialog {...baseProps} onCancel={onCancel} loading />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
