import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogLayerContent,
  DialogTitle,
} from './dialog';

/**
 * BACKLOG-4226: a pointerdown on a `[data-modal-exempt]` control is not an
 * outside click, so it does not dismiss the dialog. Everything else outside
 * still does. A caller's own onPointerDownOutside still runs, and cannot
 * remove the exemption.
 */
type Outside = (e: { target: EventTarget | null; defaultPrevented: boolean }) => void;

function Harness({
  onOpenChange,
  onPointerDownOutside,
  layer = false,
}: {
  onOpenChange: (open: boolean) => void;
  onPointerDownOutside?: Outside;
  layer?: boolean;
}) {
  const Content = layer ? DialogLayerContent : DialogContent;
  return (
    <>
      <button type="button" data-modal-exempt style={{ pointerEvents: 'auto' }}>
        exempt
      </button>
      <button type="button" style={{ pointerEvents: 'auto' }}>
        plain
      </button>
      <Dialog open onOpenChange={onOpenChange}>
        <Content
          aria-describedby={undefined}
          onPointerDownOutside={
            onPointerDownOutside
              ? (e) => onPointerDownOutside({ target: e.target, defaultPrevented: e.defaultPrevented })
              : undefined
          }
        >
          <DialogTitle>Modal</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </Content>
      </Dialog>
    </>
  );
}

// Radix adds its outside-pointerdown listener on a timeout after mount.
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

describe.each([
  ['DialogContent', false],
  ['DialogLayerContent', true],
] as const)('%s modal exemption', (_name, layer) => {
  it('a pointerdown on a [data-modal-exempt] control does not dismiss', async () => {
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} layer={layer} />);
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'exempt', hidden: true }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Modal' })).toBeTruthy();
  });

  it('a pointerdown on any other outside control still dismisses', async () => {
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} layer={layer} />);
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'plain', hidden: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("runs the caller's onPointerDownOutside too, after the exemption", async () => {
    const onOpenChange = jest.fn();
    const seen: Array<{ exempt: boolean; prevented: boolean }> = [];
    render(
      <Harness
        layer={layer}
        onOpenChange={onOpenChange}
        onPointerDownOutside={(e) =>
          seen.push({
            exempt: !!(e.target as Element).closest('[data-modal-exempt]'),
            prevented: e.defaultPrevented,
          })
        }
      />
    );
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'exempt', hidden: true }));
    expect(onOpenChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'plain', hidden: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(seen).toEqual([
      { exempt: true, prevented: true },
      { exempt: false, prevented: false },
    ]);
  });
});
