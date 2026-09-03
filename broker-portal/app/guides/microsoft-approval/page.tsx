import Link from 'next/link';
import {
  ChevronLeft,
  Contact,
  Eye,
  KeyRound,
  Mail,
  Share2,
  UserCircle,
} from 'lucide-react';
import { AlertBanner } from '@keepr/ui';

/**
 * Public Microsoft approval guide (BACKLOG-3092).
 *
 * Written to be sent to a prospective customer's IT department on its own, so
 * it MUST render fully without a Keepr session. It lives outside the
 * middleware's protected prefix (`/dashboard`) — see
 * `__tests__/app/guides/microsoft-approval.test.tsx`, which asserts that.
 *
 * Every claim on this page is checked against the code that implements it:
 *   - Settings card + Grant button ....... app/dashboard/settings/page.tsx
 *   - admin/it_admin gate on the card .... lib/actions/scim.ts getConsentStatus
 *   - /setup provisioning + redirect ..... app/auth/setup/callback/route.ts
 *   - join-existing-org on tenant match .. rpc auto_provision_it_admin
 *   - consent recorded only with state ... app/setup/consent/callback/route.ts
 *   - token in OS credential store ....... electron/services/tokenEncryptionService.ts
 *   - submissions upload message bodies .. electron/services/submissionService.ts
 *   - audit log sync to cloud ............ electron/services/supabaseService.ts
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
 * registration (the portal generates this same URI at runtime).
 */
const FALLBACK_CONSENT_URL =
  `https://login.microsoftonline.com/organizations/adminconsent` +
  `?client_id=${DESKTOP_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent('https://app.keeprcompliance.com/setup/consent/callback')}`;

const PERMISSIONS = [
  {
    icon: UserCircle,
    label: 'Sign in and read user profile',
    detail: 'Name and work email of the person signed in, so Keepr knows whose mailbox it is looking at.',
  },
  {
    icon: Mail,
    label: 'Read user mail',
    detail: 'Read the Outlook messages of the person who is signed in.',
  },
  {
    icon: Contact,
    label: 'Read user contacts',
    detail: 'Read their own Outlook contacts, to identify who is on a transaction.',
  },
  {
    icon: Share2,
    label: 'Read user and shared mail',
    detail: 'Read mailboxes that person has already been given access to in Exchange — no others.',
  },
  {
    icon: Share2,
    label: 'Read user and shared contacts',
    detail: 'The same rule for shared contact folders they already have access to.',
  },
  {
    icon: KeyRound,
    label: 'Maintain access to data you have given it access to',
    detail: 'Refresh the token in the background so nobody has to sign in again every hour.',
  },
];

export const metadata = {
  title: 'Approving Keepr for Microsoft Outlook - Keepr',
  description:
    'How an administrator approves the Keepr desktop app for read-only access to Microsoft Outlook mail and contacts, what is granted, and how to verify or revoke it.',
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

          {/* What this is */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">What you are being asked to approve</h2>
            <p className="mt-3 text-gray-700">
              Keepr is a desktop application that real estate brokerages use to assemble the
              communication record behind a transaction. To do that it reads the mail and contacts
              of the person using it, from that person&apos;s own Outlook mailbox.
            </p>
            <p className="mt-3 text-gray-700">
              Microsoft asks an administrator to approve that access once for the organization.
              Until someone does, every employee is prompted individually by Microsoft the first
              time they connect their mailbox &mdash; and in a tenant where user consent is turned
              off, they are stopped with <strong>&quot;Need admin approval&quot;</strong> and cannot
              continue on their own.
            </p>
            <p className="mt-3 text-gray-700">
              Approving takes about a minute. Two routes follow: one for an administrator who
              already has a Keepr account, one for an administrator who does not.
            </p>
          </section>

          {/* Who can approve */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">Who can approve</h2>
            <p className="mt-3 text-gray-700">
              Microsoft requires a directory role that can consent on the organization&apos;s
              behalf. Any of these can:
            </p>
            <ul className="mt-3 space-y-1 text-gray-700 list-disc list-inside">
              <li>Privileged Role Administrator</li>
              <li>Cloud Application Administrator</li>
              <li>Application Administrator</li>
            </ul>
            <p className="mt-3 text-gray-700">
              A Global Administrator can as well, because that role includes those permissions
              &mdash; but it is not required here. Keepr asks only for delegated permissions, never
              a Microsoft Graph application permission, so the narrower application-administrator
              roles are enough. Anyone without one of these roles sees{' '}
              <strong>&quot;Need admin approval&quot;</strong> and cannot proceed.
            </p>
          </section>

          {/* Path 1: existing account */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">
              If you already have a Keepr account
            </h2>
            <p className="mt-3 text-gray-700">
              This is the route to use for a first approval, and the only route to use to grant
              again after a revoke or after someone skipped the prompt during setup.
            </p>

            <ol className="mt-4 space-y-4">
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">1.</strong> Sign in to the Keepr portal at{' '}
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
                  and find the <strong>Desktop App Permissions</strong> card.
                </p>
                <p className="mt-2 text-sm text-gray-600">
                  The card answers &quot;has this already happened?&quot; on its own: it shows{' '}
                  <strong>Granted</strong> with the date it was granted, or <strong>Not granted</strong>.
                </p>
              </li>
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">3.</strong> Click{' '}
                  <strong>Grant permissions with Microsoft</strong>. If the card already says
                  Granted, the same action is there as <strong>Re-grant</strong>.
                </p>
              </li>
              <li className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">4.</strong> Microsoft shows the approval screen
                  listing the permissions below. Review them and select <strong>Accept</strong>.
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
              The Desktop App Permissions card is only shown to a Keepr account that is an
              administrator of its organization. If you are signed in and cannot see it, your Keepr
              account is a member rather than an administrator &mdash; ask whoever set the
              organization up, or contact us.
            </AlertBanner>
          </section>

          {/* Path 2: no account yet */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">
              If you don&apos;t have a Keepr account yet
            </h2>
            <p className="mt-3 text-gray-700">
              Go to{' '}
              <Link href="/setup" className="text-primary-600 hover:underline font-medium">/setup</Link>{' '}
              and sign in with your work Microsoft account. That one flow does three things:
            </p>
            <ul className="mt-3 space-y-2 text-gray-700 list-disc list-inside">
              <li>Creates your Keepr account and makes it an administrator.</li>
              <li>
                Attaches it to your brokerage&apos;s organization in Keepr &mdash; joining the one
                already registered for your Microsoft tenant if there is one, and otherwise
                creating one from your email domain.
              </li>
              <li>Takes you straight to the same Microsoft approval screen.</li>
            </ul>
            <p className="mt-3 text-gray-700">
              Approve there and you are done. Afterwards you have an account you can sign back in
              to, to check the approval, grant it again, or manage your team.
            </p>
            <AlertBanner variant="warning" className="mt-4">
              <strong>Use a work or school account.</strong> Personal Microsoft accounts
              (Outlook.com, Hotmail, Live) are rejected at this step &mdash; organization setup has
              to be tied to a Microsoft Entra ID tenant.
            </AlertBanner>
          </section>

          {/* What is granted */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">What is being granted</h2>
            <p className="mt-3 text-gray-700">
              The Microsoft approval screen lists six permissions:
            </p>

            <div className="mt-4 bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
              {PERMISSIONS.map((permission) => {
                const Icon = permission.icon;
                return (
                  <div key={permission.label} className="flex items-start gap-3 p-4 sm:p-5">
                    <div className="flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-full bg-primary-50 text-primary-600">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{permission.label}</p>
                      <p className="mt-1 text-sm text-gray-600">{permission.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-full bg-green-50 text-green-600">
                  <Eye className="h-4 w-4" />
                </div>
                <p className="text-sm text-gray-700">
                  <strong className="text-gray-900">Every one of them is read-only.</strong> There
                  is no application permission in the list, and nothing in it permits sending,
                  writing, moving, or deleting mail, contacts, or anything else in your tenant.
                </p>
              </div>
            </div>
          </section>

          {/* The "all users" sentence */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">
              What &quot;all users in your organization&quot; means on that screen
            </h2>
            <p className="mt-3 text-gray-700">
              Microsoft&apos;s approval screen says the approval applies to all users in your
              organization. That is the sentence people stop at, so it is worth being exact about.
            </p>
            <p className="mt-3 text-gray-700">
              It means <strong>nobody has to be prompted individually</strong>. It does not mean
              Keepr can read everyone&apos;s mail.
            </p>
            <p className="mt-3 text-gray-700">
              Every permission in the list is <strong>delegated</strong>. A delegated permission
              only works in the context of a person who is signed in, and only reaches what that
              person could already open themselves. Each employee still connects their own Outlook
              mailbox in the desktop app, and Keepr reads that mailbox and no other. Approving does
              not hand Keepr a key to the tenant, and it does not by itself cause a single mailbox
              to be read.
            </p>
            <p className="mt-3 text-gray-700">
              The two &quot;shared&quot; lines follow the same rule: they cover mailboxes and
              contact folders that the signed-in person has already been granted access to in
              Exchange &mdash; a team mailbox they are a member of, for instance &mdash; not
              everyone else&apos;s.
            </p>
          </section>

          {/* Where the data goes */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">Where the data goes</h2>
            <p className="mt-3 text-gray-700">
              Mail and contacts are read by the Keepr desktop app running on the employee&apos;s
              own computer. The Microsoft token it uses is stored on that computer, encrypted by
              the operating system&apos;s credential store &mdash; Keychain on macOS, DPAPI on
              Windows.
            </p>
            <p className="mt-3 text-gray-700">
              Some of it does reach our servers, and we would rather tell you where than let you
              find out:
            </p>
            <ul className="mt-3 space-y-2 text-gray-700 list-disc list-inside">
              <li>
                <strong>Transaction submissions.</strong> When an agent submits a completed
                transaction for review, the messages and attachments in that transaction are
                uploaded so a broker can read them. That is deliberate, it is initiated by the
                person submitting, and it is the point of the product.
              </li>
              <li>
                <strong>Audit logs.</strong> The desktop app syncs a log of its own actions
                &mdash; sign-ins, transaction and contact changes, exports, submissions, and
                mailbox connections, with a timestamp for each. Some of those entries currently
                carry names and property addresses from the transaction they describe. Narrowing
                that is work in progress.
              </li>
            </ul>
            <p className="mt-3 text-gray-700">
              What is <em>not</em> uploaded is the rest of the mailbox. Mail that is never attached
              to a submitted transaction stays on the employee&apos;s computer. If you want the
              full list of what we store and for how long before you approve, ask us and we will
              send it.
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
                  Microsoft reuses whichever account your browser is already signed in to, which is
                  usually the reason an approval screen shows the wrong name. Open the approval in a
                  private or incognito window and sign in with the administrator account, or sign
                  out of the other account first.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  &quot;Need admin approval&quot;
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  The account you signed in with does not hold a role that can consent for the
                  organization. Ask a Privileged Role Administrator, Cloud Application
                  Administrator, or Application Administrator to complete the approval. Nothing is
                  broken and nothing needs undoing first.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Someone clicked &quot;Skip for now&quot; during setup
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Skipping breaks nothing and can be undone at any time &mdash; but it does not go
                  away on its own. Until an administrator grants the approval, every employee is
                  prompted individually the first time they connect Outlook, and if your tenant has
                  user consent turned off they are blocked with &quot;Need admin approval&quot;. Go
                  back through{' '}
                  <Link href="/dashboard/settings" className="text-primary-600 hover:underline">
                    Settings
                  </Link>{' '}
                  &rarr; <strong>Desktop App Permissions</strong> to finish it.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Verifying or revoking the approval in Microsoft
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
                  application, and look at <strong>Permissions</strong>. Every permission granted
                  is listed there, and you can revoke them there at any time without involving us.
                  Revoking stops Microsoft issuing new tokens. An access token already in hand
                  keeps working until it expires, which is about an hour; after that the desktop
                  app cannot refresh it and the person has to reconnect.
                </p>
                <p className="mt-2 text-sm text-gray-600">
                  Keepr&apos;s own Settings card records <em>when consent was granted</em>; it is
                  not a live read of Microsoft. After a revoke in Entra it will still show the
                  earlier grant, so treat Entra as the source of truth.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Last resort: approving without signing in to Keepr
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  If you cannot sign in to the Keepr portal at all, this link opens the same
                  Microsoft approval screen directly. It works for any tenant &mdash; Microsoft
                  applies it to the tenant of whichever account you sign in with.
                </p>
                <p className="mt-2 break-all rounded-md bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700 font-mono">
                  {FALLBACK_CONSENT_URL}
                </p>
                <p className="mt-2 text-sm text-gray-700">
                  <strong>Prefer the Settings route where you can.</strong> This link grants the
                  approval in Microsoft, and that part is real &mdash; but it cannot record the
                  approval against your organization in Keepr, because the button inside the portal
                  is what identifies which organization to record it against. After using it,
                  Microsoft returns you to a Keepr page and the Settings card will still read{' '}
                  <strong>Not granted</strong>. Your users are unblocked either way; the record just
                  will not reflect it until an administrator grants it once from Settings.
                </p>
              </div>
            </div>
          </section>

          {/* Footer */}
          <section className="mt-12 pt-6 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              Questions before you approve?{' '}
              <a
                href="mailto:support@keeprcompliance.com"
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
