'use client';

/**
 * Domain verification — the interactive half of /dashboard/settings/domain. BACKLOG-3962.
 *
 * Rendered ONLY by ./page.tsx, which refuses anyone who is not an admin or IT admin of the
 * brokerage. It carries no gate of its own. Every action re-checks on the server.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy } from 'lucide-react';
// Badge/Card family/Input/Label/PageHeader are Tier-2 (no @keepr/ui equivalent yet).
import { Badge, Card, CardContent, CardHeader, Input, Label, PageHeader } from '@keepr/design-system';
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

export default function DomainSettingsClient({ claims, loadState }: DomainSettingsClientProps) {
  const router = useRouter();
  const [domainInput, setDomainInput] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const refresh = () => startTransition(() => router.refresh());

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('add');
    setNotice(null);
    try {
      const res = await createDomainClaim(domainInput);
      setNotice({ claimId: null, tone: res.success ? 'info' : 'destructive', text: res.message });
      if (res.success) {
        setDomainInput('');
        refresh();
      }
    } catch {
      setNotice({ claimId: null, tone: 'destructive', text: DOMAIN_CLAIM_FAILED });
    } finally {
      setBusy(null);
    }
  };

  const handleCheck = async (claimId: string) => {
    setBusy(claimId);
    setNotice(null);
    try {
      const res = await checkDomainClaim(claimId);
      setNotice({ claimId, tone: res.success ? 'success' : 'destructive', text: res.message });
      refresh();
    } catch {
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
      <PageHeader
        phoneHideTitle
        phoneHideSubtitle
        title={PAGE_TITLES.domain}
        subtitle="Prove your brokerage owns its email domain by adding a DNS record"
      />

      {loadState === 'unavailable' && <AlertBanner variant="warning">{DOMAIN_CLAIM_UNAVAILABLE}</AlertBanner>}
      {loadState === 'error' && <AlertBanner variant="destructive">{DOMAIN_CLAIM_FAILED}</AlertBanner>}
      {notice && notice.claimId === null && <AlertBanner variant={notice.tone}>{notice.text}</AlertBanner>}

      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Add a domain</h2>
          <p className="mt-1 text-sm text-gray-500">
            Enter only the domain your team&apos;s email addresses use, for example brokerage.com. Each
            subdomain is verified on its own.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
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
              />
            </div>
            <Button type="submit" disabled={busy !== null || loadState !== 'ok' || domainInput.trim() === ''}>
              {busy === 'add' ? 'Adding...' : 'Add domain'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {claims.map((claim) => {
        const badge = STATUS_BADGE[claim.status];
        const live = claim.status === 'pending' || claim.status === 'verified' || claim.status === 'lapsed';
        const lastResult =
          claim.lastCheckResult && claim.lastCheckResult !== 'verified' && claim.status !== 'verified'
            ? checkResultMessage(claim.lastCheckResult, claim.domain)
            : null;
        return (
          <Card key={claim.id} padding="none" data-testid={`domain-claim-${claim.id}`}>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-900">
                  <DomainName claim={claim} />
                </h2>
                <Badge hue={badge.hue}>{badge.label}</Badge>
              </div>
              {claim.status === 'verified' && claim.verifiedAt && (
                <p className="mt-1 text-sm text-gray-500">
                  Verified {new Date(claim.verifiedAt).toLocaleDateString()}. Keep the record in place:
                  Keepr checks it again every day.
                </p>
              )}
              {claim.status === 'lapsed' && (
                <p className="mt-1 text-sm text-gray-500">
                  Verification lapsed: the TXT record is gone. Add it back and click Check.
                </p>
              )}
              {claim.status === 'revoked' && (
                <p className="mt-1 text-sm text-gray-500">
                  Contact support@keeprcompliance.com if you think this is a mistake.
                </p>
              )}
            </CardHeader>
            {live && claim.recordValue && (
              <CardContent>
                <div className="space-y-3">
                  {claim.status !== 'verified' && (
                    <p className="text-sm text-gray-700">
                      At your DNS host, add a TXT record with this name and value. Leave your other
                      records as they are.
                    </p>
                  )}
                  <CopyField id={`name-${claim.id}`} label="Name" value={claim.recordName} />
                  <CopyField id={`value-${claim.id}`} label="Value" value={claim.recordValue} />
                  {notice && notice.claimId === claim.id ? (
                    <AlertBanner variant={notice.tone}>{notice.text}</AlertBanner>
                  ) : (
                    lastResult && <p className="text-sm text-gray-500">Last check: {lastResult}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={() => handleCheck(claim.id)} disabled={busy !== null}>
                      {busy === claim.id ? 'Checking...' : 'Check'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => handleRemove(claim.id)}
                      disabled={busy !== null}
                    >
                      {confirmRemove === claim.id ? 'Confirm remove' : 'Remove'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
