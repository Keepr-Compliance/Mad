'use client';

import * as React from 'react';
import { Button } from '../button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../dialog';
import { Dropdown } from '../dropdown';
import type { DropdownOption } from '../dropdown/types';

/**
 * ShareDialog (BACKLOG-4087): the owner shares one saved view.
 *
 * Built on the kit Dialog (Radix: focus trap, Escape, `aria-modal`, focus
 * return) and the kit Dropdown. Like SavedViews it makes NO data calls: the
 * adopter feeds the people who may be picked (`candidates`), the current
 * grants (`grants`) and any refusal (`error`), and performs the writes in
 * `onGrant` and `onRemove`.
 *
 * `candidates` MUST come from a server-side function scoped to this view and
 * caller (in the admin portal, `report_share_candidates`), never a full user
 * list: the kit shows exactly what it is given.
 *
 * - The role select defaults to "Can view" (viewer) and returns to it after
 *   each share.
 * - People who already have access are not offered again; to change a role,
 *   remove the grant and share again.
 * - Remove asks first, inside the dialog, per person: "Remove access for
 *   <name>?" with Cancel / Remove access. Only the confirm calls `onRemove`.
 *   No browser confirm prompt. The first Escape while a confirm is showing
 *   cancels the confirm; the next closes the dialog.
 * - Hiding or showing these controls is presentation only. The server
 *   functions decide who may share, and refuse everyone else.
 */
export type ShareRole = 'viewer' | 'editor';

/** A person the owner may share with: id and display name only. */
export interface ShareCandidate {
  id: string;
  name: string;
}

/** One current grant on the view. */
export interface ShareGrant {
  userId: string;
  name: string;
  role: ShareRole;
}

export interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The view being shared, for the title. */
  viewName: string;
  /** Who may be picked, from a server-side scoped function. Null while loading or unavailable. */
  candidates: readonly ShareCandidate[] | null;
  /** Who has access now. Null while loading or unavailable. */
  grants: readonly ShareGrant[] | null;
  /** What the server said when it refused the last write, or null. */
  error: string | null;
  /** Give `userId` access with `role`. */
  onGrant: (userId: string, role: ShareRole) => void;
  /** Take access away from `grant`. Called only after the in-dialog confirm. */
  onRemove: (grant: ShareGrant) => void;
}

const ROLE_OPTIONS: DropdownOption<ShareRole>[] = [
  { value: 'viewer', label: 'Can view', description: 'Opens the view' },
  { value: 'editor', label: 'Can edit', description: 'Also updates its filters and metric' },
];

const ROLE_LABEL: Record<ShareRole, string> = { viewer: 'Can view', editor: 'Can edit' };

export function ShareDialog({
  open,
  onOpenChange,
  viewName,
  candidates,
  grants,
  error,
  onGrant,
  onRemove,
}: ShareDialogProps) {
  const [userId, setUserId] = React.useState<string | null>(null);
  const [role, setRole] = React.useState<ShareRole>('viewer');
  /** The grant whose Remove confirm is showing, by user id. */
  const [removeId, setRemoveId] = React.useState<string | null>(null);
  const confirmCancelRef = React.useRef<HTMLButtonElement>(null);

  // A closed dialog forgets its picks and any open confirm.
  React.useEffect(() => {
    if (open) return;
    setUserId(null);
    setRole('viewer');
    setRemoveId(null);
  }, [open]);

  const restoreRemoveFocus = React.useRef<string | null>(null);
  const grantListRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => {
    if (removeId !== null) {
      confirmCancelRef.current?.focus();
    } else if (restoreRemoveFocus.current !== null) {
      const id = restoreRemoveFocus.current;
      restoreRemoveFocus.current = null;
      const buttons = grantListRef.current?.querySelectorAll<HTMLButtonElement>('[data-remove-for]') ?? [];
      Array.from(buttons).find((b) => b.dataset.removeFor === id)?.focus();
    }
  }, [removeId]);

  function cancelRemove() {
    restoreRemoveFocus.current = removeId;
    setRemoveId(null);
  }

  const granted = new Set((grants ?? []).map((g) => g.userId));
  const options: DropdownOption[] = (candidates ?? [])
    .filter((c) => !granted.has(c.id))
    .map((c) => ({ value: c.id, label: c.name }));
  const pickedUserId = userId !== null && options.some((o) => o.value === userId) ? userId : null;

  function share() {
    if (pickedUserId === null) return;
    onGrant(pickedUserId, role);
    setUserId(null);
    setRole('viewer');
  }

  function confirmRemove(grant: ShareGrant) {
    setRemoveId(null);
    onRemove(grant);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="share-dialog"
        onEscapeKeyDown={(e) => {
          if (removeId !== null) {
            e.preventDefault();
            cancelRemove();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Share {viewName}</DialogTitle>
          <DialogDescription>People you add see this view under “Shared with you”.</DialogDescription>
        </DialogHeader>

        {candidates === null ? (
          <p className="text-sm text-gray-500">Loading people…</p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Dropdown
                label="Person"
                placeholder={options.length === 0 ? 'No one else to add' : 'Choose a person'}
                options={options}
                value={pickedUserId}
                onChange={setUserId}
                disabled={options.length === 0}
              />
            </div>
            <div className="sm:w-36">
              <Dropdown<ShareRole>
                label="Access"
                options={ROLE_OPTIONS}
                value={role}
                onChange={setRole}
                searchable={false}
              />
            </div>
            <Button type="button" onClick={share} disabled={pickedUserId === null}>
              Share
            </Button>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-sm text-danger-600">
            {error}
          </p>
        ) : null}

        <div>
          <p className="mb-1 text-xs font-medium uppercase text-gray-500">People with access</p>
          {grants === null ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : grants.length === 0 ? (
            <p className="text-sm text-gray-500">Only you</p>
          ) : (
            <ul ref={grantListRef} aria-label="People with access" className="max-h-56 divide-y divide-gray-100 overflow-y-auto">
              {grants.map((grant) => (
                <li key={grant.userId} data-slot="share-grant" className="py-2 text-sm">
                  {removeId === grant.userId ? (
                    <div role="group" aria-label={`Remove access for ${grant.name}`} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-gray-700" title={grant.name}>
                        Remove access for {grant.name}?
                      </span>
                      <Button ref={confirmCancelRef} type="button" variant="ghost" size="sm" onClick={cancelRemove}>
                        Cancel
                      </Button>
                      <Button type="button" variant="destructive" size="sm" onClick={() => confirmRemove(grant)}>
                        Remove access
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-gray-900" title={grant.name}>
                        {grant.name}
                      </span>
                      <span className="flex-shrink-0 text-xs text-gray-500">{ROLE_LABEL[grant.role]}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${grant.name}`}
                        data-remove-for={grant.userId}
                        onClick={() => setRemoveId(grant.userId)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
