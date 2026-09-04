import Link from 'next/link';

/**
 * Public Microsoft approval guide (BACKLOG-3092, trimmed and retitled by
 * BACKLOG-3097).
 *
 * TITLED AFTER THE SYSTEM BEING CONNECTED — the convention 1Password uses for
 * its connector pages. The former title, "Approving Keepr for Microsoft
 * Outlook", was wrong twice: the consent is granted on the app registration in
 * Entra ID at tenant level, not in Outlook, and it covers contacts as well as
 * mail.
 *
 * THE ROUTE DOES NOT FOLLOW THE TITLE. `/guides/microsoft-approval` has already
 * been emailed to a prospect. Renaming the directory or adding a redirect
 * breaks a live link — the title changed, the path did not.
 *
 * NO BREADCRUMB, DELIBERATELY. There was a "Back to Help" link above the title;
 * it is gone and must not come back. Readers reach this page from a link in an
 * email forwarded to their IT team — they have never been to /help, so "back"
 * points at a page they did not come from and implies history they do not have.
 * The page stands alone. The test asserts /help is not linked from here.
 *
 * Written to be sent to a prospective customer's IT department on its own, so
 * it MUST render fully without a Keepr session. It lives outside the
 * middleware's protected prefix (`/dashboard`) — see
 * `__tests__/app/guides/microsoft-approval.test.tsx`, which asserts that.
 *
 * OPERATIONAL, NOT EXPLANATORY. The reader is following a guide. Keep four
 * things and nothing else:
 *
 *   - what to click
 *   - what to expect
 *   - what to do when it fails
 *   - what is true of the grant
 *
 * Cut anything that explains how Keepr works internally, who can see what, or
 * why something behaves as it does. BACKLOG-3097 applied that test across the
 * whole page in one pass. A troubleshooting entry in particular is symptom then
 * action, never a paragraph of consequence with the action buried at the end.
 *
 * Prerequisites come FIRST because they are the gate — a reader without one of
 * those roles stops there instead of reaching step 4 and failing.
 *
 * IT DOES ENUMERATE THE GRANTED PERMISSIONS, which reverses BACKLOG-3092. That
 * cut was made because a hand-written copy of the consent screen is what let
 * the app registration drift out of sync with what customers were told. The
 * reason it is safe now is GRANTED_SCOPES below: one pinned list, verified
 * against the live screen, asserted as an exact ordered set by the test — so a
 * silent drift fails CI instead of reaching a customer. An IT reviewer can then
 * evaluate the grant without clicking through to a consent screen.
 *
 * Every claim is checked against the code that implements it:
 *   - Settings card + Grant button ....... app/dashboard/settings/page.tsx
 *   - /setup sign-in lands on consent .... app/auth/setup/callback/route.ts
 *   - consent recorded only with state ... app/setup/consent/callback/route.ts
 *   - read-only, delegated scope set ..... electron/services/microsoftAuthService.ts
 *   - token in OS credential store ....... electron/services/tokenEncryptionService.ts
 *   - "reconnect in Settings" on a dead
 *     refresh token (invalid_grant) ...... microsoftAuthService.refreshToken ->
 *                                          emailSyncService.classifyProviderError
 *
 * Deliberately makes NO claim about SSO, JIT or SCIM (asserted by the test).
 */

/**
 * The four roles that can grant this, Global Administrator first — it is the
 * role most admins hold and recognise.
 *
 * Verified 2026-09-04 against the app registration: after Mail.Send
 * (Application) was removed, every remaining permission is delegated and none
 * carries "Admin consent required: Yes", so all four of these roles suffice.
 * DO NOT add or drop a role here without re-checking the registration.
 */
/**
 * HARDCODED, AND IT HAS TO BE MAINTAINED BY HAND.
 *
 * Deriving this from the file's last git commit would be better, and it is not
 * available here: `next build` on Vercel runs against a shallow clone and the
 * deployed runtime has no `.git` at all, so a `git log` at render time returns
 * nothing and a `git log` at build time returns nothing for any file that was
 * not touched in the fetched depth. Either way the page would silently claim a
 * wrong date, which on a security page is worse than claiming none.
 *
 * Instead the staleness guard lives in the test: it pins a fingerprint of this
 * file, so ANY edit here fails the suite until the date below is reviewed and
 * the fingerprint re-pinned. Change one, change the other.
 */
const LAST_UPDATED = 'September 4, 2026';

/**
 * The exact six lines Microsoft's consent screen renders, verified against the
 * live screen on 2026-09-03 after Mail.Send (Application) was removed from the
 * app registration. The left column is the scope name as it appears in Entra.
 *
 * THE PAGE AND THE SCREEN MUST AGREE — them disagreeing is what caused this
 * cleanup. Do not add, drop or reword an entry without re-reading the
 * registration.
 */
const GRANTED_SCOPES: ReadonlyArray<{ scope: string; allows: string }> = [
  { scope: 'User.Read', allows: "Sign in and read the user's own profile" },
  { scope: 'offline_access', allows: 'Keep the connection active without prompting again' },
  { scope: 'Mail.Read', allows: "Read the signed-in user's mail, to build the audit trail" },
  { scope: 'Mail.Read.Shared', allows: 'Read shared mailboxes that user already has access to' },
  {
    scope: 'Contacts.Read',
    allows: "Read the signed-in user's contacts, to identify transaction participants",
  },
  {
    scope: 'Contacts.Read.Shared',
    allows: 'Read shared contacts that user already has access to',
  },
];

const APPROVER_ROLES = [
  'Global Administrator',
  'Privileged Role Administrator',
  'Cloud Application Administrator',
  'Application Administrator',
];

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
  title: 'Connecting Keepr to Entra ID (Microsoft 365) - Keepr',
  description:
    'How an administrator approves the Keepr desktop app for read-only access to Microsoft Outlook mail and contacts, and how to verify or revoke it.',
};

export default function MicrosoftApprovalGuidePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900">
            Connecting Keepr to Entra ID (Microsoft 365)
          </h1>
          <p className="mt-2 text-sm text-gray-500">{`Last updated ${LAST_UPDATED}`}</p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-10 sm:px-6 lg:px-8">
        <div className="max-w-none">

          {/* Prerequisites — first, because it is the gate. A reader without
              one of these roles stops here rather than at step 4. */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">Prerequisites</h2>
            <p className="mt-3 text-gray-700">
              To complete this, one of the following admin roles is required:
            </p>
            <ul className="mt-3 space-y-1 text-gray-700 list-disc list-inside">
              {APPROVER_ROLES.map((role) => (
                <li key={role}>{role}</li>
              ))}
            </ul>
          </section>

          {/* One section, one flow: the setup link, with Settings as the
              fallback inside it. Not two parallel routes with two headings. */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">Approving Keepr</h2>
            <p className="mt-3 text-gray-700">
              Go to{' '}
              <Link href="/setup" className="text-primary-600 hover:underline font-medium">/setup</Link>{' '}
              and sign in with your work Microsoft account. Review Microsoft&apos;s approval screen
              and select <strong>Accept</strong>.
            </p>

            <p className="mt-4 text-gray-700">
              If that does not work, do it manually from Settings:
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
          </section>

          {/* Every scope, in a table with a plain-English column, so an IT
              reviewer can evaluate the grant without clicking through to a
              consent screen. BACKLOG-3092 had removed this list on the grounds
              that a hand-written copy goes stale; BACKLOG-3097 restores it with
              GRANTED_SCOPES pinned to the registration and asserted by the
              test, which is the answer to that objection. */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">What is granted</h2>
            <p className="mt-3 text-gray-700">
              <strong>Read permissions only.</strong> There is no send, write, or delete permission,
              and no application-level permission &mdash; Keepr cannot reach a mailbox unless that
              person is signed in on their own computer.
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-sm text-left border border-gray-200 rounded-lg bg-white">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th scope="col" className="px-4 py-2 font-semibold text-gray-900">
                      Permission
                    </th>
                    <th scope="col" className="px-4 py-2 font-semibold text-gray-900">
                      What it allows
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {GRANTED_SCOPES.map(({ scope, allows }) => (
                    <tr key={scope} className="border-b border-gray-200 last:border-b-0">
                      <td className="px-4 py-2 whitespace-nowrap font-mono text-xs text-gray-900">
                        {scope}
                      </td>
                      <td className="px-4 py-2 text-gray-700">{allows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-gray-700">
              The Microsoft token is stored on that person&apos;s own computer, encrypted by the
              operating system&apos;s credential store. Access can be revoked at any time in Entra
              ID &rarr; Enterprise applications.
            </p>
          </section>

          {/* Troubleshooting. Each entry is symptom, then action. Nothing else. */}
          <section className="border-t border-gray-200 pt-8 mt-12">
            <h2 className="text-xl font-semibold text-gray-900">Troubleshooting</h2>

            <div className="mt-6 space-y-6">
              <div>
                <h3 className="text-base font-medium text-gray-900">
                  The wrong Microsoft account is signed in
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Open the approval in a private or incognito window and sign in with the
                  administrator account, or sign out of the other account first.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  &quot;Need admin approval&quot;
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Hand the approval to someone holding one of the roles listed under Prerequisites.
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
                  for about an hour, after which that person is told their email connection has
                  expired and to reconnect in Settings.
                </p>
                <p className="mt-2 text-sm text-gray-600">
                  After a revoke in Entra, Keepr&apos;s Settings card still shows the earlier grant.
                  Entra is the source of truth.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Last resort: approving without signing in to Keepr
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  This link opens the Microsoft approval screen directly. It applies to the tenant
                  of whichever account signs in.
                </p>
                <p className="mt-2 break-all rounded-md bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700 font-mono">
                  {FALLBACK_CONSENT_URL}
                </p>
                <p className="mt-2 text-sm text-gray-700">
                  <strong>Use the Settings route instead where you can.</strong> This link grants
                  the approval in Microsoft but does not record it in Keepr. Your users are
                  unblocked either way; the Settings card will still read{' '}
                  <strong>Not granted</strong> until an administrator grants it once from Settings.
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
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
