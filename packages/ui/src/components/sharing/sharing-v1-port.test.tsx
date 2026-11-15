import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SharingDialog } from './sharing-dialog';
import type { SharingDialogProps, SharingEntry, SharingPrincipal } from './types';

/**
 * BACKLOG-3513 PR-4: the v1 ShareDialog (saved-views, BACKLOG-4087) is deleted. These are the
 * v1 behaviours (its suite: C6b2, C6f, C6h, C7b) that the SharingDialog suite
 * (sharing-dialog.test.tsx) did not already cover, run against SharingDialog. The rest of
 * the v1 suite is covered there: default level and its reset after Share (K5), people already on
 * the list not offered (K5c), remove confirm and focus return (K4, K9), refusal alert (K9c),
 * no data calls (K8).
 *
 * Moved here from saved-views/ in BACKLOG-3513 PR-6.
 * Fixtures are invented.
 */
const JORDAN: SharingEntry = { id: 'u-jl', kind: 'person', name: 'Jordan Lee', level: 'editor' };
const SAM: SharingPrincipal = { id: 'u-so', kind: 'person', name: 'Sam Ortiz' };

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

function setup(overrides: Partial<SharingDialogProps> = {}) {
  const props: SharingDialogProps = {
    open: true,
    onOpenChange: jest.fn(),
    name: 'Pipeline',
    candidates: [SAM],
    entries: [JORDAN],
    error: null,
    onGrant: jest.fn(),
    onChangeLevel: jest.fn(),
    onRemove: jest.fn(),
    ...overrides,
  };
  return render(<SharingDialog {...props} />);
}

const dialog = () => screen.getByRole('dialog', { name: 'Share “Pipeline”' });
const input = () => screen.getByRole('combobox', { name: 'Add people or roles' });
const accessSelect = () => screen.getByRole('button', { name: /^Access Can/ });

describe('SharingDialog: behaviour ported from the deleted v1 ShareDialog (BACKLOG-3513 PR-4)', () => {
  it('P1 (v1 C6b2) an empty candidate list offers nobody: the list says so and has no real option', () => {
    setup({ candidates: [] });
    expect(input()).not.toBeDisabled();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['No one else to add']);
    expect(options[0]).toHaveAttribute('aria-disabled', 'true');
  });

  it('P2 (v1 C6f) focus is trapped in the dialog: it starts inside and Tab never leaves it', async () => {
    render(
      <>
        <button type="button">outside</button>
        <SharingDialog
          open
          onOpenChange={jest.fn()}
          name="Pipeline"
          candidates={[SAM]}
          entries={[JORDAN]}
          error={null}
          onGrant={jest.fn()}
          onChangeLevel={jest.fn()}
          onRemove={jest.fn()}
        />
      </>
    );
    await settle();
    const d = dialog();
    expect(d.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 12; i++) {
      await userEvent.tab();
      expect(d.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      await userEvent.tab({ shift: true });
      expect(d.contains(document.activeElement)).toBe(true);
    }
  });

  it('P3 (v1 C6h) a long name is truncated with a title', () => {
    const long = 'Bartholomew Featherstonehaugh-Montgomery the Third';
    setup({ entries: [{ id: 'u-x', kind: 'person', name: long, level: 'viewer' }] });
    const name = screen.getByText(long);
    expect(name).toHaveClass('truncate');
    expect(name).toHaveAttribute('title', long);
  });

  it('P4 (v1 C7b) caller copy: the description and each level line are the caller\'s, in the select and the row menu', () => {
    setup({
      description: 'People you add can open this report.',
      levels: [
        { value: 'viewer', label: 'Can view', description: 'Opens the report' },
        { value: 'editor', label: 'Can edit', description: 'Also shares saved views on it' },
      ],
    });
    expect(dialog()).toHaveTextContent('People you add can open this report.');
    fireEvent.click(accessSelect());
    const opts = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(opts.find((o) => o.startsWith('Can view'))).toContain('Opens the report');
    expect(opts.find((o) => o.startsWith('Can edit'))).toContain('Also shares saved views on it');
    fireEvent.click(accessSelect());
    fireEvent.click(screen.getByRole('button', { name: 'Access for Jordan Lee: Can edit' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /^Can edit/ })).toHaveTextContent('Also shares saved views on it');
    expect(within(menu).getByRole('menuitemradio', { name: /^Can view/ })).toHaveTextContent('Opens the report');
  });
});
