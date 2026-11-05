import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareDialog } from './share-dialog';
import type { ShareCandidate, ShareDialogProps, ShareGrant } from './share-dialog';

/**
 * BACKLOG-4087 PR 2 (kit), control C6. Rendered with controlled open={true}
 * (confirmation-dialog.test.tsx pattern). Focus moves in Radix FocusScope's
 * setTimeout(0), so focus assertions flush timers first (`settle`, as in
 * dropdown-sheet.test.tsx).
 *
 * Fixtures are invented. Two grants, so a confirm that is not keyed per
 * person shows (C6c).
 */
const CANDIDATES: ShareCandidate[] = [
  { id: 'u-ava', name: 'Avery Quinn' },
  { id: 'u-bo', name: 'Bo Larkspur' },
  { id: 'u-cy', name: 'Cyrus Vale' },
];
const GRANTS: ShareGrant[] = [
  { userId: 'u-bo', name: 'Bo Larkspur', role: 'editor' },
  { userId: 'u-cy', name: 'Cyrus Vale', role: 'viewer' },
];

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

function setup(overrides: Partial<ShareDialogProps> = {}) {
  const props: ShareDialogProps = {
    open: true,
    onOpenChange: jest.fn(),
    viewName: 'Pipeline',
    candidates: CANDIDATES,
    grants: GRANTS,
    error: null,
    onGrant: jest.fn(),
    onRemove: jest.fn(),
    ...overrides,
  };
  const utils = render(<ShareDialog {...props} />);
  return { ...utils, props };
}

const dialog = () => screen.getByRole('dialog', { name: 'Share Pipeline' });
const personTrigger = () => screen.getByRole('button', { name: /^Person/ });
const accessTrigger = () => screen.getByRole('button', { name: /^Access/ });

describe('ShareDialog (BACKLOG-4087)', () => {
  it('C6a the role defaults to viewer: picking a person and sharing grants "viewer"', () => {
    const { props } = setup();
    expect(accessTrigger()).toHaveTextContent('Can view');
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    fireEvent.click(personTrigger());
    fireEvent.click(screen.getByRole('option', { name: /Avery Quinn/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onGrant).toHaveBeenCalledTimes(1);
    expect(props.onGrant).toHaveBeenCalledWith('u-ava', 'viewer');
  });

  it('C6a2 choosing "Can edit" grants editor, and the role returns to viewer after the share', () => {
    const { props } = setup();
    fireEvent.click(personTrigger());
    fireEvent.click(screen.getByRole('option', { name: /Avery Quinn/ }));
    fireEvent.click(accessTrigger());
    fireEvent.click(screen.getByRole('option', { name: /Can edit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onGrant).toHaveBeenCalledWith('u-ava', 'editor');
    expect(accessTrigger()).toHaveTextContent('Can view');
  });

  it('C6b the picker offers only the caller-fed people, less those who already have access', () => {
    setup();
    fireEvent.click(personTrigger());
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['Avery Quinn']);
  });

  it('C6b2 candidates null shows loading and no picker; an empty list disables it', () => {
    const { rerender, props } = setup({ candidates: null });
    expect(screen.getByText('Loading people…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Person/ })).toBeNull();
    rerender(<ShareDialog {...props} candidates={[]} />);
    expect(personTrigger()).toBeDisabled();
  });

  it('C6c Remove asks in the dialog first; Cancel calls nothing; the confirm removes only that person', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo Larkspur' }));
    expect(props.onRemove).not.toHaveBeenCalled();
    const ask = screen.getByRole('group', { name: 'Remove access for Bo Larkspur' });
    await settle();
    expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /Remove access for/ })).toBeNull();
    expect(props.onRemove).not.toHaveBeenCalled();
    // arm Bo, then Cyrus: only Cyrus's confirm remains
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo Larkspur' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cyrus Vale' }));
    expect(screen.queryByRole('group', { name: 'Remove access for Bo Larkspur' })).toBeNull();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove access for Cyrus Vale' })).getByRole('button', { name: 'Remove access' })
    );
    expect(props.onRemove).toHaveBeenCalledTimes(1);
    expect(props.onRemove).toHaveBeenCalledWith(GRANTS[1]);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('C6g Cancel on the Remove confirm, by button or Escape, returns focus to that person\'s Remove button', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cyrus Vale' }));
    await settle();
    fireEvent.click(within(screen.getByRole('group', { name: 'Remove access for Cyrus Vale' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Remove Cyrus Vale' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo Larkspur' }));
    await settle();
    await act(async () => {
      await userEvent.keyboard('{Escape}');
    });
    expect(screen.getByRole('button', { name: 'Remove Bo Larkspur' })).toHaveFocus();
  });

  it('C6d current grants are listed with their role and a Remove each; none says "Only you"', () => {
    const { rerender, props } = setup();
    const list = screen.getByRole('list', { name: 'People with access' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Bo LarkspurCan editRemove',
      'Cyrus ValeCan viewRemove',
    ]);
    rerender(<ShareDialog {...props} grants={[]} />);
    expect(screen.getByText('Only you')).toBeInTheDocument();
  });

  it('C6e Escape with a Remove confirm open cancels the confirm only; the next Escape asks to close', async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo Larkspur' }));
    await settle();
    await act(async () => {
      await userEvent.keyboard('{Escape}');
    });
    expect(screen.queryByRole('group', { name: /Remove access for/ })).toBeNull();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('C6f focus is trapped in the dialog: it starts inside and Tab never leaves it', async () => {
    render(
      <>
        <button type="button">outside</button>
        <ShareDialog
          open
          onOpenChange={jest.fn()}
          viewName="Pipeline"
          candidates={CANDIDATES}
          grants={GRANTS}
          error={null}
          onGrant={jest.fn()}
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

  it('C6g a refusal from the store is shown as an alert', () => {
    setup({ error: 'Saved view not found' });
    expect(screen.getByRole('alert')).toHaveTextContent('Saved view not found');
  });

  it('C6h a long name is truncated with a title', () => {
    const long = 'Bartholomew Featherstonehaugh-Montgomery the Third';
    setup({ grants: [{ userId: 'u-x', name: long, role: 'viewer' }] });
    const name = screen.getByText(long);
    expect(name).toHaveClass('truncate');
    expect(name).toHaveAttribute('title', long);
  });

  // BACKLOG-4144: the copy is the caller's to set; absent, it is the saved-view copy.
  function roleLines() {
    fireEvent.click(accessTrigger());
    const lines = ['Can view', 'Can edit'].map((label) => {
      const option = screen.getByRole('option', { name: new RegExp(`^${label}`) });
      const desc = option.querySelector('[id$="-desc"]');
      return desc?.textContent ?? null;
    });
    fireEvent.click(accessTrigger());
    return lines;
  }
  const descriptionText = () => document.getElementById(dialog().getAttribute('aria-describedby') ?? '')?.textContent ?? null;

  it('C7a no description props: today\'s saved-view copy, exact', () => {
    setup();
    expect(descriptionText()).toBe('People you add see this view under “Shared with you”.');
    expect(roleLines()).toEqual(['Opens the view', 'Also updates its filters and metric']);
  });

  it('C7b report copy passed in: the description and both role lines are the caller\'s', () => {
    setup({
      description: 'People you add can open this report.',
      roleDescriptions: { viewer: 'Opens the report', editor: 'Also shares saved views on it' },
    });
    expect(descriptionText()).toBe('People you add can open this report.');
    expect(roleLines()).toEqual(['Opens the report', 'Also shares saved views on it']);
    expect(dialog()).not.toHaveTextContent('Shared with you');
  });

  it('S2 the dialog makes no data calls: no network or browser storage in its source', () => {
    const source = fs.readFileSync(path.join(__dirname, 'share-dialog.tsx'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|supabase\.|\.rpc\(|localStorage|sessionStorage|XMLHttpRequest|indexedDB|window\.confirm/i);
  });
});
