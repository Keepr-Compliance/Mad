'use client';

/**
 * Domains on the organization page — BACKLOG-3962 PR2. Every claim the brokerage made, newest
 * first, from admin_list_domain_claims (organizations.view; the token is never returned).
 * Revoke shows only with organizations.edit (canRevoke, read by the page); the server action and
 * admin_revoke_domain_claim check it again. A reason is required and goes to the audit log.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  FieldError,
  FieldHelp,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  Textarea,
  type BadgeHue,
} from '@keepr/design-system';
import { formatDate } from '@/lib/format';
import { revokeDomainClaimAction } from '@/lib/actions/domainClaims';
import {
  REVOKE_REASON_MAX,
  checkRevokeReason,
  domainClaimStatusLabel,
  isRevocable,
  type AdminDomainClaim,
} from '@/lib/domainClaimRules';

const STATUS_HUE: Record<string, BadgeHue> = {
  pending: 'yellow',
  verified: 'green',
  lapsed: 'orange',
  withdrawn: 'gray',
  revoked: 'red',
};

export interface DomainClaimsCardProps {
  organizationId: string;
  claims: AdminDomainClaim[];
  canRevoke: boolean;
  /** The read failed: say so instead of claiming there are no domains. */
  failed?: boolean;
}

export function DomainClaimsCard({ organizationId, claims, canRevoke, failed = false }: DomainClaimsCardProps) {
  const [revoking, setRevoking] = useState<AdminDomainClaim | null>(null);

  return (
    <Card data-testid="domain-claims-card">
      <CardTitle>Domains</CardTitle>
      {failed ? (
        <Alert className="mt-2">Couldn&apos;t load domains.</Alert>
      ) : claims.length === 0 ? (
        <EmptyState card={false} title="No domains claimed." />
      ) : (
        <ul className="mt-2 divide-y divide-gray-100 text-sm">
          {claims.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="domain-claim-row">
              <span className="flex flex-wrap items-center gap-2 text-gray-900">
                <span className="font-medium">{c.domain}</span>
                <Badge hue={STATUS_HUE[c.status] ?? 'gray'}>{domainClaimStatusLabel(c.status)}</Badge>
                {c.status === 'verified' && c.verified_at && (
                  <span className="text-gray-500">since {formatDate(c.verified_at)}</span>
                )}
                {c.status === 'revoked' && c.revoke_reason && (
                  <span className="text-gray-500">— {c.revoke_reason}</span>
                )}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-gray-500">
                  {c.last_checked_at ? `Checked ${formatDate(c.last_checked_at)}` : 'Not checked yet'}
                </span>
                {canRevoke && isRevocable(c.status) && (
                  <Button variant="secondary" size="xs" onClick={() => setRevoking(c)} data-testid="domain-claim-revoke">
                    Revoke
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canRevoke && revoking && (
        <RevokeDomainDialog organizationId={organizationId} claim={revoking} onClose={() => setRevoking(null)} />
      )}
    </Card>
  );
}

function RevokeDomainDialog({
  organizationId,
  claim,
  onClose,
}: {
  organizationId: string;
  claim: AdminDomainClaim;
  onClose: () => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const checked = checkRevokeReason(reason);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await revokeDomainClaimAction(organizationId, claim.id, checked.reason);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    router.refresh();
  };

  return (
    <Modal open onClose={onClose} title={`Revoke ${claim.domain}`} dismissible={!saving}>
      <ModalBody>
        <p className="text-sm text-gray-600">
          The brokerage loses this domain at once. Another brokerage can then claim it.
        </p>
        <div className="mt-4">
          <Label htmlFor="domain-revoke-reason" required>Reason</Label>
          <Textarea
            id="domain-revoke-reason"
            rows={2}
            maxLength={REVOKE_REASON_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this domain being revoked?"
          />
          <FieldHelp>Saved in the audit log with your name.</FieldHelp>
        </div>
        {error && <FieldError className="mt-3">{error}</FieldError>}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={saving}>{saving ? 'Revoking…' : 'Revoke domain'}</Button>
      </ModalFooter>
    </Modal>
  );
}
