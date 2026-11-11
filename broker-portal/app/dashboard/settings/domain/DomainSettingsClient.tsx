'use client';

/**
 * Domain verification — the interactive half of /dashboard/settings/domain. BACKLOG-3962.
 *
 * Rendered ONLY by ./page.tsx, which refuses anyone who is not an admin or IT admin of the
 * brokerage. It carries no gate of its own. Every action re-checks on the server.
 */

import { Fragment, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, ChevronLeft, Copy } from 'lucide-react';
// Badge/Card family/Input/Label/PageHeader are Tier-2 (no @keepr/ui equivalent yet).
import {
  Badge,
  EmptyState,
  Input,
  Label,
  Modal,
  PageHeader,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Th,
  Tr,
} from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { checkDomainClaim, createDomainClaim, withdrawDomainClaim } from '@/lib/actions/domainClaim';
import {
  DOMAIN_CLAIM_FAILED,
  DOMAIN_CLAIM_UNAVAILABLE,
  checkResultMessage,
  type DomainClaimStatus,
  type DomainClaimView,
} from '@/lib/domain/claims';

type BadgeHue = 'gray' | 'green' | 'yellow' | 'red';

const STATUS_BADGE: Record<DomainClaimStatus, { label: string; hue: BadgeHue }> = {
  pending: { label: 'Not verified yet', hue: 'yellow' },
  verified: { label: 'Verified', hue: 'green' },
  lapsed: { label: 'Verification lapsed', hue: 'red' },
  withdrawn: { label: 'Removed', hue: 'gray' },
  revoked: { label: 'Revoked by Keepr support', hue: 'red' },
};

interface Notice {
  claimId: string | null;
  tone: 'success' | 'destructive' | 'info';
  text: string;
}

export interface DomainSettingsClientProps {
  claims: DomainClaimView[];
  loadState: 'ok' | 'unavailable' | 'error';
}

/** The domain as a person reads it; an internationalised name also shows its A-label (R10). */
export function DomainName({ claim }: { claim: Pick<DomainClaimView, 'domain' | 'unicodeDomain' | 'isInternationalized'> }) {
  if (!claim.isInternationalized) return <span>{claim.domain}</span>;
  return (
    <span>
      {claim.unicodeDomain} <span className="text-sm font-normal text-gray-500">({claim.domain})</span>
    </span>
  );
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500" id={`${id}-label`}>
        {label}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <code
          aria-labelledby={`${id}-label`}
          className="flex-1 min-w-0 break-all bg-gray-50 px-3 py-2 rounded-md text-sm font-mono text-gray-800 border border-gray-200"
        >
          {value}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          Copy
        </Button>
      </div>
    </div>
  );
}

/** The relative label a DNS host wants (`_keepr`); the full name when it is not under the domain. */
export function hostLabel(recordName: string, domain: string): string {
  const suffix = `.${domain}`;
  return recordName.endsWith(suffix) && recordName.length > suffix.length
    ? recordName.slice(0, -suffix.length)
    : recordName;
}

function RecordFields({ claim }: { claim: DomainClaimView }) {
  return (
    <div className="space-y-3">
      <CopyField id={`host-${claim.id}`} label="Host" value={hostLabel(claim.recordName, claim.domain)} />
      <CopyField id={`value-${claim.id}`} label="Value" value={claim.recordValue ?? ''} />
      <p className="text-sm text-gray-500">
        Most DNS hosts add your domain to the end of the Host for you. If yours asks for the full name,
        use <code className="font-mono text-gray-800">{claim.recordName}</code>.
      </p>
    </div>
  );
}

export default function DomainSettingsClient({ claims, loadState }: DomainSettingsClientProps) {
  const router = useRouter();
  const [domainInput, setDomainInput] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Rows whose DNS instructions are open (pending/lapsed rows start collapsed).
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [, startTransition] = useTransition();

  const refresh = () => startTransition(() => router.refresh());

  const openAdd = () => {
    setAddError(null);
    setAddOpen(true);
  };
  const closeAdd = () => {
    setAddError(null);
    setAddOpen(false);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('add');
    setNotice(null);
    setAddError(null);
    try {
      const res = await createDomainClaim(domainInput);
      if (res.success) {
        setNotice({ claimId: null, tone: 'info', text: res.message });
        // Open the claim the RPC returned (a re-add of a listed pending domain included).
        if (res.claimId) {
          const id = res.claimId;
          setOpenIds((o) => ({ ...o, [id]: true }));
        }
        setDomainInput('');
        setAddOpen(false);
        refresh();
      } else {
        // The dialog is still open: the error belongs inside it, not on the page behind it.
        setAddError(res.message);
      }
    } catch {
      setAddError(DOMAIN_CLAIM_FAILED);
    } finally {
      setBusy(null);
    }
  };

  const handleCheck = async (claimId: string) => {
    setBusy(claimId);
    setNotice(null);
    try {
      const res = await checkDomainClaim(claimId);
      setOpenIds((o) => ({ ...o, [claimId]: true }));
      setNotice({ claimId, tone: res.success ? 'success' : 'destructive', text: res.message });
      refresh();
    } catch {
      setOpenIds((o) => ({ ...o, [claimId]: true }));
      setNotice({ claimId, tone: 'destructive', text: DOMAIN_CLAIM_FAILED });
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (claimId: string) => {
    if (confirmRemove !== claimId) {
      setConfirmRemove(claimId);
      return;
    }
    setConfirmRemove(null);
    setBusy(claimId);
    setNotice(null);
    try {
      const res = await withdrawDomainClaim(claimId);
      setNotice({ claimId: null, tone: res.success ? 'info' : 'destructive', text: res.message });
      if (res.success) refresh();
    } catch {
      setNotice({ claimId: null, tone: 'destructive', text: DOMAIN_CLAIM_FAILED });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <Link
        href="/dashboard/settings"
        className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to Settings
      </Link>
      <PageHeader
        phoneHideTitle
        phoneHideSubtitle
        title={PAGE_TITLES.domain}
        subtitle="Prove your brokerage owns its email domain by adding a DNS record"
        actions={
          <Button type="button" onClick={openAdd} disabled={loadState !== 'ok'}>
            Add domain
          </Button>
        }
      />

      {loadState === 'unavailable' && <AlertBanner variant="warning">{DOMAIN_CLAIM_UNAVAILABLE}</AlertBanner>}
      {loadState === 'error' && <AlertBanner variant="destructive">{DOMAIN_CLAIM_FAILED}</AlertBanner>}
      {notice && notice.claimId === null && <AlertBanner variant={notice.tone}>{notice.text}</AlertBanner>}

      <Modal
        open={addOpen}
        onClose={closeAdd}
        title={<span id="add-domain-title">Add a domain</span>}
        aria-labelledby="add-domain-title"
        dismissible={busy !== 'add'}
      >
        <p className="text-sm text-gray-500">
          Enter only the domain your team&apos;s email addresses use, for example brokerage.com. Each
          subdomain is verified on its own.
        </p>
        <form onSubmit={handleAdd} className="mt-4 space-y-4">
          <div>
            <Label htmlFor="domain-claim-input">Domain</Label>
            <Input
              id="domain-claim-input"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="brokerage.com"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              disabled={loadState !== 'ok'}
              autoFocus
            />
          </div>
          {addError && (
            <p className="text-sm text-red-600" role="alert">
              {addError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeAdd} disabled={busy === 'add'}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy !== null || loadState !== 'ok' || domainInput.trim() === ''}>
              {busy === 'add' ? 'Adding...' : 'Add'}
            </Button>
          </div>
        </form>
      </Modal>

      {claims.length === 0 ? (
        loadState === 'ok' && (
          <EmptyState
            title="No domains yet"
            description="Add your brokerage's email domain to verify it."
            action={
              <Button type="button" onClick={openAdd}>
                + Add domain
              </Button>
            }
          />
        )
      ) : (
        <TableContainer scrollX>
          <Table>
            <TableHead>
              <tr>
                <Th>Domain</Th>
                <Th>Status</Th>
                <Th>Verified</Th>
                <Th>Added by</Th>
                <Th>Actions</Th>
              </tr>
            </TableHead>
            <TableBody>
              {claims.map((claim) => {
                const badge = STATUS_BADGE[claim.status];
                const live = claim.status === 'pending' || claim.status === 'verified' || claim.status === 'lapsed';
                const lastResult =
                  claim.lastCheckResult && claim.lastCheckResult !== 'verified' && claim.status !== 'verified'
                    ? checkResultMessage(claim.lastCheckResult, claim.domain)
                    : null;
                const showNotice = notice && notice.claimId === claim.id;
                const collapsible = claim.status === 'pending' || claim.status === 'lapsed';
                const isVerified = claim.status === 'verified';
                const isOpen = !!openIds[claim.id];
                const detailId = `domain-instructions-${claim.id}`;
                const hasDetail = collapsible
                  ? isOpen
                  : isVerified
                    ? (isOpen && !!claim.recordValue) || !!showNotice
                    : (live && !!claim.recordValue) || claim.status === 'revoked' || !!showNotice;
                return (
                  <Fragment key={claim.id}>
                    <Tr data-testid={`domain-claim-${claim.id}`}>
                      <Td emphasis="primary" className="whitespace-normal">
                        <DomainName claim={claim} />
                      </Td>
                      <Td>
                        <Badge hue={badge.hue}>{badge.label}</Badge>
                      </Td>
                      <Td>
                        {claim.status === 'verified' && claim.verifiedAt ? (
                          new Date(claim.verifiedAt).toLocaleDateString()
                        ) : collapsible ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            aria-label={`Instructions for ${claim.domain}`}
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? detailId : undefined}
                            onClick={() => setOpenIds((o) => ({ ...o, [claim.id]: !o[claim.id] }))}
                          >
                            Instructions
                          </Button>
                        ) : (
                          '\u2014'
                        )}
                      </Td>
                      <Td>{claim.addedBy ?? '\u2014'}</Td>
                      <Td>
                        {live && claim.recordValue && (
                          <div className="flex flex-wrap items-center gap-2">
                            {isVerified ? (
                              <Button
                                type="button"
                                variant="secondary"
                                aria-expanded={isOpen}
                                aria-controls={isOpen ? detailId : undefined}
                                onClick={() => setOpenIds((o) => ({ ...o, [claim.id]: !o[claim.id] }))}
                              >
                                {isOpen ? 'Hide DNS record' : 'Show DNS record'}
                              </Button>
                            ) : (
                              <Button type="button" onClick={() => handleCheck(claim.id)} disabled={busy !== null}>
                                {busy === claim.id ? 'Checking...' : 'Check'}
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => handleRemove(claim.id)}
                              disabled={busy !== null}
                            >
                              {confirmRemove === claim.id ? 'Confirm remove' : 'Remove'}
                            </Button>
                          </div>
                        )}
                      </Td>
                    </Tr>
                    {hasDetail && (
                      <tr id={detailId}>
                        <td colSpan={5} className="px-6 pb-4 pt-0 bg-white">
                          <div className="space-y-3">
                            {claim.status === 'verified' && claim.verifiedAt && (
                              <p className="text-sm text-gray-500">Keep the record in place: Keepr checks it again every day.</p>
                            )}
                            {claim.status === 'lapsed' && (
                              <p className="text-sm text-gray-500">
                                Verification lapsed: the TXT record is gone. Add it back and click Check.
                              </p>
                            )}
                            {claim.status === 'revoked' && (
                              <p className="text-sm text-gray-500">
                                Contact support@keeprcompliance.com if you think this is a mistake.
                              </p>
                            )}
                            {live && claim.recordValue &&
                              (isVerified ? (
                                <RecordFields claim={claim} />
                              ) : (
                                <>
                                  <p className="text-sm text-gray-700">
                                    At your DNS host, add a TXT record. Leave your other records as they are.
                                  </p>
                                  <RecordFields claim={claim} />
                                </>
                              ))}
                            {showNotice ? (
                              <AlertBanner variant={notice.tone}>{notice.text}</AlertBanner>
                            ) : (
                              lastResult && <p className="text-sm text-gray-500">Last check: {lastResult}</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
