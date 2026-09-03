import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { AlertBanner } from '@keepr/ui';

/**
 * Public Microsoft approval guide (BACKLOG-3092).
 *
 * Written to be sent to a prospective customer's IT department on its own, so
 * it MUST render fully without a Keepr session. It lives outside the
 * middleware's protected prefix (`/dashboard`) — see
 * `__tests__/app/guides/microsoft-approval.test.tsx`, which asserts that.
 *
 * OPERATIONAL, NOT PERSUASIVE. The reader is following a guide, not being sold
 * to — the selling happened in the email that sent them here. Prefer a step, a
 * heading or a short list over a paragraph, and cut any sentence that explains
 * motivation rather than saying what to do or what is true.
 *
 * It also deliberately does NOT enumerate the granted permissions. Microsoft's
 * consent screen is the authority on WHAT is granted; a hand-written copy of
 * that list is what let the app registration drift out of sync with what we
 * told people. The page makes a claim about the SHAPE of the grant (read-only,
 * delegated, no application permission) instead, which does not go stale when a
 * permission is added or renamed. A test asserts the list stays out.
 *
 * Every claim is checked against the code that implements it:
 *   - Settings card + Grant button ....... app/dashboard/settings/page.tsx
 *   - admin/it_admin gate on the card .... lib/actions/scim.ts getConsentStatus
 *   - /setup provisioning + redirect ..... app/auth/setup/callback/route.ts
 *   - join-existing-org on tenant match .. rpc auto_provision_it_admin
 *   - consent recorded only with state ... app/setup/consent/callback/route.ts
 *   - delegated, read-only scope set ..... electron/services/microsoftAuthService.ts
 *   - token in OS credential store ....... electron/services/tokenEncryptionService.ts
 *   - "reconnect in Settings" on a dead
 *     refresh token (invalid_grant) ...... microsoftAuthService.refreshToken ->
 *                                          emailSyncService.classifyProviderError
 *
 * Deliberately makes NO claim about SSO, JIT or SCIM (asserted by the test).
 */

/**
 * Ours, and public by design — Microsoft puts it in the address bar of every
 * consent screen it renders, and the portal already ships it to the browser as
 * NEXT_PUBLIC_DESKTOP_CLIENT_ID. It is an application identifier, not a record
 * id: it names no customer, tenant, organization or person.
 */
// pii-allow-uuid: Keepr's own OAuth application (client) id, public by design — not a record id, names no customer or tenant
const DESKTOP_CLIENT_ID = '3a6c341a-17ab-4739-977d-a7d71b27f945';

/**
 * Generic `organizations` tenant so one URL serves every customer, and the
 * production portal origin as a literal so the redirect matches the app
 * registration (the portal generates this same URI at runtime; confirmed
 * against the deployed Vercel domain, not a code default).
 */
const FALLBACK_CONSENT_URL =
  `https://login.microsoftonline.com/organizations/adminconsent` +
  `?client_id=${DESKTOP_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent('https://app.keeprcompliance.com/setup/consent/callback')}`;

export const metadata = {
  title: 'Approving Keepr for Microsoft Outlook - Keepr',
  description:
    'How an administrator approves the Keepr desktop app for read-only access to Microsoft Outlook mail and contacts, and how to verify or revoke it.',
};

export default function MicrosoftApprovalGuidePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
          <Link
            href="/help"
            className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1"
          >
            <ChevronLeft className="h-4 w-4" />
            Back to Help
          </Link>
          <h1 className="mt-4 text-3xl font-bold text-gray-900">
            Approving Keepr for Microsoft Outlook
          </h1>
          <p className="mt-2 text-gray-500">
            A one-time administrator approval that lets the Keepr desktop app read a
            person&apos;s own Outlook mail and contacts, read-only, for transaction auditing.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-10 sm:px-6 lg:px-8">
        <div className="max-w-none">

          {/* Route 1 — no account yet. First, because the outreach email sends
              IT admins straight to /setup, so this is the path most readers of
              this page are already on. */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">
              If you don&apos;t have a Keepr account yet
            </h2>
            <p className="mt-3 text-gray-700">
              Go to{' '}
              <Link href="/setup" className="text-primary-600 hover:underline font-medium">/setup</Link>{' '}
              and sign in with your work Microsoft account. That one flow:
            </p>
            <ul className="mt-3 space-y-2 text-gray-700 list-disc list-inside">
              <li>Creates your Keepr account and makes it an administrator.</li>
              <li>
                Attaches it to your brokerage&apos;s organization in Keepr &mdash; joining the one
                already registered for your Microsoft tenant if there is one, and otherwise
                creating one from your email domain.
              </li>
              <li>Takes you to the Microsoft approval screen. Review it and select <strong>Accept</strong>.</li>
            </ul>
            <p className="mt-3 text-gray-700">
              You can sign back in later to check the approval, grant it again, or manage your
              team.
            </p>
            <AlertBanner variant="warning" className="mt-4">
              <strong>Use a work or school account.</strong> Personal Microsoft accounts
              (Outlook.com, Hotmail, Live) are rejected at this step.
            </AlertBanner>
          </section>

          {/* Route 2 — existing account. Also the only route that can grant
              again after a revoke or a skipped prompt. */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">
              If you already have a Keepr account
            </h2>
            <p className="mt-3 text-gray-700">
              Use this route to grant again after a revoke, or after someone skipped the prompt
              during setup.
            </p>

            <ol className="mt-4 space-y-3">
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">1.</strong> Sign in at{' '}
                  <Link href="/login" className="text-primary-600 hover:underline">/login</Link>{' '}
                  with your work Microsoft account.
                </p>
              </li>
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">2.</strong> Open{' '}
                  <Link href="/dashboard/settings" className="text-primary-600 hover:underline font-medium">
                    Settings
                  </Link>{' '}
                  &rarr; <strong>Desktop App Permissions</strong>. The card shows{' '}
                  <strong>Granted</strong> with the date, or <strong>Not granted</strong>.
                </p>
              </li>
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">3.</strong> Click{' '}
                  <strong>Grant permissions with Microsoft</strong> &mdash; or{' '}
                  <strong>Re-grant</strong>, if the card already says Granted.
                </p>
              </li>
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">4.</strong> Review Microsoft&apos;s approval
                  screen and select <strong>Accept</strong>.
                </p>
              </li>
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">5.</strong> Microsoft returns you to your Keepr
                  dashboard. Settings then shows <strong>Granted</strong> with today&apos;s date.
                </p>
              </li>
            </ol>

            <AlertBanner variant="info" className="mt-4">
              The Desktop App Permissions card is shown only to a Keepr account that is an
              administrator of its organization.
            </AlertBanner>
          </section>

          {/* Who can approve */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">Who can approve</h2>
            <p className="mt-3 text-gray-700">
              Any Microsoft Entra role that can consent on the organization&apos;s behalf:
            </p>
            <ul className="mt-3 space-y-1 text-gray-700 list-disc list-inside">
              <li>Privileged Role Administrator</li>
              <li>Cloud Application Administrator</li>
              <li>Application Administrator</li>
            </ul>
            <p className="mt-3 text-gray-700">
              Global Administrator also works, but is not required &mdash; Keepr requests no
              Microsoft Graph application permission. Anyone else sees{' '}
              <strong>&quot;Need admin approval&quot;</strong> and cannot proceed.
            </p>
          </section>

          {/* Shape of the grant — deliberately NOT an enumeration of it. */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">What the approval allows</h2>
            <p className="mt-3 text-gray-700">
              Every permission is read-only. There is no send, write, or delete permission, and no
              application-level permission &mdash; Keepr cannot reach a mailbox unless that person
              is signed in on their own computer. The Microsoft token is stored on that
              person&apos;s own computer, encrypted by the operating system&apos;s credential store.
            </p>
            <p className="mt-3 text-gray-700">
              Microsoft&apos;s screen says the approval applies to all users in your organization.
              That means nobody is prompted individually. It does not mean Keepr can read
              everyone&apos;s mail: every permission is <strong>delegated</strong>, so each employee
              still connects their own mailbox in the desktop app and Keepr reads that mailbox and
              no other.
            </p>
            <p className="mt-3 text-gray-700">
              Shared mailboxes and shared contact folders follow the same rule &mdash; only the ones
              the signed-in person has already been given access to in Exchange.
            </p>
          </section>

          {/* Troubleshooting */}
          <section className="border-t border-gray-200 pt-8 mt-12">
            <h2 className="text-xl font-semibold text-gray-900">Troubleshooting</h2>

            <div className="mt-6 space-y-6">
              <div>
                <h3 className="text-base font-medium text-gray-900">
                  The wrong Microsoft account is signed in
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Microsoft reuses whichever account the browser is already signed in to. Open the
                  approval in a private or incognito window and sign in with the administrator
                  account, or sign out of the other account first.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  &quot;Need admin approval&quot;
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  The signed-in account does not hold a role that can consent for the organization.
                  Hand it to a Privileged Role Administrator, Cloud Application Administrator, or
                  Application Administrator.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Someone clicked &quot;Skip for now&quot; during setup
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Until an administrator grants the approval, every employee is prompted
                  individually the first time they connect Outlook &mdash; and if your tenant has
                  user consent turned off, they are blocked with &quot;Need admin approval&quot;.
                  Finish it through{' '}
                  <Link href="/dashboard/settings" className="text-primary-600 hover:underline">
                    Settings
                  </Link>{' '}
                  &rarr; <strong>Desktop App Permissions</strong>.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Verifying or revoking the approval
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  In the{' '}
                  <a
                    href="https://entra.microsoft.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    Microsoft Entra admin center
                  </a>
                  , go to <strong>Enterprise applications</strong>, open the Keepr desktop
                  application, and look at <strong>Permissions</strong>. Everything granted is
                  listed there, and you can revoke it there at any time without involving us.
                </p>
                <p className="mt-2 text-sm text-gray-700">
                  Revoking stops Microsoft issuing new tokens. A token already in hand keeps working
                  until it expires, which is about an hour. Once the desktop app can no longer
                  refresh, it tells that person their email connection has expired and to reconnect
                  in Settings.
                </p>
                <p className="mt-2 text-sm text-gray-600">
                  Keepr&apos;s Settings card records when consent was granted; it is not a live read
                  of Microsoft. After a revoke in Entra it still shows the earlier grant, so treat
                  Entra as the source of truth.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Last resort: approving without signing in to Keepr
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  This link opens the same Microsoft approval screen directly, for any tenant &mdash;
                  Microsoft applies it to the tenant of whichever account signs in.
                </p>
                <p className="mt-2 break-all rounded-md bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700 font-mono">
                  {FALLBACK_CONSENT_URL}
                </p>
                <p className="mt-2 text-sm text-gray-700">
                  <strong>Use the Settings route instead where you can.</strong> This link grants
                  the approval in Microsoft, but cannot record it against your organization in
                  Keepr &mdash; the button inside the portal is what identifies which organization
                  to record it against. Your users are unblocked either way; the Settings card will
                  still read <strong>Not granted</strong> until an administrator grants it once from
                  Settings.
                </p>
              </div>
            </div>
          </section>

          {/* Footer */}
          <section className="mt-12 pt-6 border-t border-gray-200">
            {/* Absolute, not a relative <Link>: this page is a sales asset and
                its text gets pasted into email, where a relative href is dead.
                /support/new is outside the middleware's protected prefix and
                collects name, email, category and description, so an IT admin
                with no Keepr account can file a ticket that lands in the
                support module rather than in someone's inbox. */}
            <p className="text-sm text-gray-500">
              Questions before you approve?{' '}
              <a
                href="https://app.keeprcompliance.com/support/new"
                className="text-primary-600 hover:underline"
              >
                Contact support
              </a>{' '}
              &mdash; we would rather answer them than have you guess.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
