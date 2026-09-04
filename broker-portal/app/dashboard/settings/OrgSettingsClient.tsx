'use client';

/**
 * Organization policy — the interactive half of /dashboard/settings.
 *
 * BACKLOG-3078 split this out of page.tsx, which is now a server component that
 * refuses a non-admin before any of this markup exists.
 *
 * Two things left this file in that split:
 *   - Session Management moved to /dashboard/account. ActiveSessionsList
 *     documents itself as "devices where the user is currently logged in", and
 *     SignOutAllButton signs THAT PERSON out everywhere. It was the only
 *     genuinely personal thing on an org-policy page.
 *   - The decision about how a gated card renders. This component is handed a
 *     policy per card and renders it. It does not know which features are
 *     unbuilt, and there is no per-key conditional here — see
 *     lib/feature-availability.ts.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import {
  getConsentStatus,
  getRetentionPolicy,
  updateRetentionPolicy,
  getJitStatus,
  updateJitStatus,
} from '@/lib/actions/scim';
import { useImpersonation } from '@/components/providers/ImpersonationProvider';
import type { OrgSettingsFeatureView } from '@/lib/org-settings-access';
// Badge/Card family/Label/PageHeader/Select are Tier-2 (no @keepr/ui equivalent yet).
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  Label,
  PageHeader,
  Select,
} from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';

interface ConsentInfo {
  organizationId: string;
  tenantId: string | null;
  consentGranted: boolean;
  consentGrantedAt: string | null;
}

const RETENTION_OPTIONS = [
  { value: 1, label: '1 year' },
  { value: 2, label: '2 years' },
  { value: 3, label: '3 years' },
  { value: 5, label: '5 years' },
  { value: 7, label: '7 years' },
  { value: 10, label: '10 years' },
];

export interface OrgSettingsClientProps {
  /** How each gated card renders, resolved server-side. */
  features: OrgSettingsFeatureView;
}

export default function OrgSettingsClient({ features }: OrgSettingsClientProps) {
  const { isImpersonating } = useImpersonation();
  const [consent, setConsent] = useState<ConsentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [retentionYears, setRetentionYears] = useState(7);
  const [savedRetention, setSavedRetention] = useState(7);
  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [jitEnabled, setJitEnabled] = useState(true);
  const [savingJit, setSavingJit] = useState(false);

  const desktopClientId = process.env.NEXT_PUBLIC_DESKTOP_CLIENT_ID || '';

  const showJit = features.jit.policy !== 'hidden';
  const showScim = features.scim.policy !== 'hidden';
  const showRetention = features.retention.policy !== 'hidden';
  // A grayed card is visible and inert. Impersonation disables everything too,
  // but for a different reason, so the two are kept separate rather than merged
  // into one "disabled" boolean whose meaning nobody could recover later.
  const retentionLocked = features.retention.policy !== 'enabled';

  useEffect(() => {
    async function load() {
      // getJitStatus is fail-closed (BACKLOG-3094) and throws when the feature
      // is off. Calling it unconditionally inside the Promise.all below would
      // let a JIT refusal blank the consent and retention cards next to it.
      if (showJit) {
        getJitStatus()
          .then((jit) => setJitEnabled(jit.enabled))
          .catch(() => {
            /* card is hidden or the caller is refused; leave the default */
          });
      }

      try {
        const [consentData, retentionData] = await Promise.all([
          getConsentStatus(),
          getRetentionPolicy(),
        ]);
        setConsent(consentData);
        setRetentionYears(retentionData.retentionYears);
        setSavedRetention(retentionData.retentionYears);
      } catch {
        // User may not be admin/it_admin
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [showJit]);

  async function handleRetentionSave() {
    setSavingRetention(true);
    setRetentionSaved(false);
    try {
      await updateRetentionPolicy(retentionYears);
      setSavedRetention(retentionYears);
      setRetentionSaved(true);
      setTimeout(() => setRetentionSaved(false), 3000);
    } catch {
      // Error handling
    } finally {
      setSavingRetention(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-6">
        <PageHeader title="Settings" subtitle="Loading..." />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Manage your organization settings"
      />

      {/* Read-only banner during impersonation */}
      {isImpersonating && (
        <AlertBanner variant="warning">Read-only during support session</AlertBanner>
      )}

      {/* Desktop App Permissions.
          Org-level by definition: one grant covers the whole tenant and it
          writes graph_admin_consent_granted on the organization. BACKLOG-3090
          redirects the consent callback to this page so an admin lands on this
          card — do not move or rename the route without checking that. */}
      {consent && (
        <Card padding="none">
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">
              Desktop App Permissions
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Grant org-wide permissions so team members can connect their Outlook in the desktop app
            </p>
          </CardHeader>
          <CardContent>
            {consent.consentGranted ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Badge hue="green">Granted</Badge>
                  <span className="text-sm text-gray-500">
                    Admin consent granted
                    {consent.consentGrantedAt && (
                      <> on {new Date(consent.consentGrantedAt).toLocaleDateString('en-US', {
                        year: 'numeric', month: 'short', day: 'numeric',
                      })}</>
                    )}
                  </span>
                </div>
                {consent.tenantId && desktopClientId && (
                  <button
                    onClick={() => {
                      const redirectUri = `${window.location.origin}/setup/consent/callback`;
                      const consentUrl = `https://login.microsoftonline.com/${consent.tenantId}/adminconsent?client_id=${desktopClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${consent.organizationId}`;
                      window.location.href = consentUrl;
                    }}
                    disabled={isImpersonating}
                    className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Re-grant
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Badge hue="yellow">Not granted</Badge>
                  <span className="text-sm text-gray-500">
                    Team members will be prompted to request admin approval when connecting Outlook
                  </span>
                </div>
                {consent.tenantId && desktopClientId ? (
                  <Button
                    onClick={() => {
                      const redirectUri = `${window.location.origin}/setup/consent/callback`;
                      const consentUrl = `https://login.microsoftonline.com/${consent.tenantId}/adminconsent?client_id=${desktopClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${consent.organizationId}`;
                      window.location.href = consentUrl;
                    }}
                    disabled={isImpersonating}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 23 23">
                      <path fill="#f35325" d="M1 1h10v10H1z" />
                      <path fill="#81bc06" d="M12 1h10v10H12z" />
                      <path fill="#05a6f0" d="M1 12h10v10H1z" />
                      <path fill="#ffba08" d="M12 12h10v10H12z" />
                    </svg>
                    Grant permissions with Microsoft
                  </Button>
                ) : (
                  <p className="text-sm text-gray-400">
                    Microsoft tenant not configured. Please contact support.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Just-in-Time Provisioning */}
      {showJit && (
        <Card padding="none">
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">
              Just-in-Time Provisioning
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Allow team members to join your organization automatically when they sign in with a matching Microsoft work account
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-700">
                  {jitEnabled
                    ? 'Anyone with a matching Microsoft tenant can sign in and join automatically'
                    : 'Users must be invited or provisioned via SCIM before they can sign in'}
                </p>
              </div>
              <button
                onClick={async () => {
                  setSavingJit(true);
                  try {
                    const newValue = !jitEnabled;
                    await updateJitStatus(newValue);
                    setJitEnabled(newValue);
                  } catch {
                    // Error handling
                  } finally {
                    setSavingJit(false);
                  }
                }}
                disabled={savingJit || isImpersonating}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 ${
                  jitEnabled ? 'bg-primary-600' : 'bg-gray-200'
                }`}
                role="switch"
                aria-checked={jitEnabled}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    jitEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Email Retention Policy.
          Grayed rather than hidden when the plan lacks it: the feature works,
          so the customer should see what an upgrade buys. updateRetentionPolicy
          carries the same check server-side — the disabled controls below are
          not the gate. */}
      {showRetention && (
        <Card padding="none">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Email Retention Policy
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Set the retention period for all team members. This overrides individual settings in the desktop app.
                </p>
              </div>
              {features.retention.unlockLabel && (
                <Badge hue="gray">{features.retention.unlockLabel}</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div
              className={retentionLocked ? 'opacity-60' : undefined}
              aria-disabled={retentionLocked || undefined}
            >
              <div className="flex items-end gap-4">
                <div className="w-48">
                  <Label htmlFor="retention-years">Retain emails for</Label>
                  <Select
                    id="retention-years"
                    value={retentionYears}
                    onChange={(e) => setRetentionYears(Number(e.target.value))}
                    disabled={isImpersonating || retentionLocked}
                  >
                    {RETENTION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  onClick={handleRetentionSave}
                  disabled={
                    savingRetention ||
                    retentionYears === savedRetention ||
                    isImpersonating ||
                    retentionLocked
                  }
                >
                  {savingRetention ? 'Saving...' : 'Save'}
                </Button>
                {retentionSaved && (
                  <span className="text-sm text-green-600">Saved</span>
                )}
              </div>
            </div>
            <p className="mt-3 text-xs text-gray-400">
              {retentionLocked
                ? 'Not in force for this organization.'
                : 'Team members will see this setting locked in their desktop app and cannot change it.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* SCIM Provisioning Link — BACKLOG-3087: gated on scim_provisioning.
          The route itself refuses server-side too; this only stops us inviting
          an IT admin to configure an endpoint that returns 404. */}
      {showScim && (
        <Link
          href="/dashboard/settings/scim"
          className="block bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md hover:border-gray-300 transition-all"
        >
          <div className="px-6 py-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                SCIM Provisioning
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Configure SCIM to automatically sync users from your identity provider
              </p>
            </div>
            <ChevronRight className="h-5 w-5 text-gray-400" />
          </div>
        </Link>
      )}
    </div>
  );
}
