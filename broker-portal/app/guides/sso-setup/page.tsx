import Link from 'next/link';
import { ChevronLeft, Mail, RefreshCw, Zap } from 'lucide-react';
import { Alert } from '@keepr/design-system';

export const metadata = {
  title: 'SSO Setup Guide - Keepr',
  description: 'How Single Sign-On works in Keepr and how to manage access for your organization.',
};

export default function SSOSetupGuidePage() {
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
            Single Sign-On (SSO)
          </h1>
          <p className="mt-2 text-gray-500">
            How SSO works in Keepr and how to control who can join your organization.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-10 sm:px-6 lg:px-8">
        <div className="max-w-none">

          {/* How SSO works */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">How SSO works</h2>
            <p className="mt-3 text-gray-700">
              SSO is enabled automatically when your organization is created. During the{' '}
              <Link href="/setup" className="text-primary-600 hover:underline">/setup</Link>{' '}
              flow, Keepr links your Microsoft Entra ID tenant to your organization. After that, anyone with a work account from that same tenant can sign in at{' '}
              <Link href="/login" className="text-primary-600 hover:underline">/login</Link>{' '}
              using <strong>Sign in with Microsoft</strong>.
            </p>
            <p className="mt-3 text-gray-700">
              There is no separate SSO configuration step. If your organization exists in Keepr, SSO is already active.
            </p>
          </section>

          {/* How team members join */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">How team members join</h2>
            <p className="mt-3 text-gray-700">
              There are three ways someone can become a member of your organization:
            </p>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5 text-center">
                <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full text-green-600 bg-green-50">
                  <Zap className="h-6 w-6" />
                </div>
                <h3 className="mt-3 text-base font-medium text-gray-900">Just-in-Time (JIT)</h3>
                <p className="mt-2 text-sm text-gray-600">
                  Users sign in with their Microsoft work account and are automatically added with the default role.
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Enabled by default. Turn off in{' '}
                  <Link href="/dashboard/settings" className="text-primary-600 hover:underline">Settings</Link>.
                </p>
              </div>

              <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5 text-center">
                <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full text-blue-600 bg-blue-50">
                  <RefreshCw className="h-6 w-6" />
                </div>
                <h3 className="mt-3 text-base font-medium text-gray-900">SCIM provisioning</h3>
                <p className="mt-2 text-sm text-gray-600">
                  Sync users automatically from Microsoft Entra ID. Assign or remove them in Azure and changes flow to Keepr.
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  <Link href="/guides/scim-provisioning" className="text-primary-600 hover:underline">Learn how to set up SCIM</Link>
                </p>
              </div>

              <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5 text-center">
                <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full text-purple-600 bg-purple-50">
                  <Mail className="h-6 w-6" />
                </div>
                <h3 className="mt-3 text-base font-medium text-gray-900">Manual invitation</h3>
                <p className="mt-2 text-sm text-gray-600">
                  Invite users by email from the Users page. They join with the role you assign when they first sign in.
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Invite from{' '}
                  <Link href="/dashboard/users" className="text-primary-600 hover:underline">Users</Link>.
                </p>
              </div>
            </div>
          </section>

          {/* JIT Provisioning toggle */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">Controlling JIT provisioning</h2>
            <p className="mt-3 text-gray-700">
              By default, any Microsoft user from your tenant can sign in and automatically join your organization. If you want tighter control &mdash; for example, only allowing users who were explicitly invited or provisioned via SCIM &mdash; you can disable JIT provisioning.
            </p>

            <div className="mt-4 bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
              <p className="text-sm text-gray-700">
                Go to{' '}
                <Link href="/dashboard/settings" className="text-primary-600 hover:underline font-medium">Settings</Link>{' '}
                and find the <strong>Just-in-Time Provisioning</strong> toggle.
              </p>
              <ul className="mt-3 space-y-2 text-sm text-gray-600">
                <li className="flex items-start gap-2">
                  <span className="font-medium text-gray-900 flex-shrink-0">On (default):</span>
                  <span>Anyone from your Microsoft tenant can sign in and join automatically.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-medium text-gray-900 flex-shrink-0">Off:</span>
                  <span>Only invited or SCIM-provisioned users can sign in. Others will see an error message asking them to contact their IT admin.</span>
                </li>
              </ul>
            </div>

            <Alert variant="warning" className="mt-3">
              <strong>Note:</strong> Turning off JIT does not remove existing members. It only prevents <em>new</em> users from joining automatically.
            </Alert>
          </section>

          {/* Desktop app permissions */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-900">Desktop app permissions (admin consent)</h2>
            <p className="mt-3 text-gray-700">
              The Keepr desktop app needs permission to read emails and contacts for transaction auditing. As an admin, you can pre-approve these permissions for your entire organization so team members don&apos;t see individual Microsoft permission prompts.
            </p>
            <ul className="mt-3 space-y-1 text-sm text-gray-700">
              <li><strong>Read email messages</strong> &mdash; for building the audit trail</li>
              <li><strong>Read contacts</strong> &mdash; for transaction participant lookup</li>
              <li><strong>Read user profile</strong> &mdash; basic identity information</li>
            </ul>
            <p className="mt-3 text-gray-700">
              You&apos;re prompted to grant admin consent right after creating your organization. If you skipped it, you can grant it anytime from{' '}
              <Link href="/dashboard/settings" className="text-primary-600 hover:underline">Settings</Link>{' '}
              under <strong>Desktop App Permissions</strong>.
            </p>
            <div className="mt-3 bg-gray-50 border border-gray-200 rounded-md p-3">
              <p className="text-sm text-gray-600">
                <strong>Skipping admin consent</strong> doesn&apos;t break anything. Each team member will just see a Microsoft permission prompt the first time they connect their mailbox in the desktop app.
              </p>
            </div>
          </section>

          {/* Troubleshooting */}
          <section className="border-t border-gray-200 pt-8 mt-12">
            <h2 className="text-xl font-semibold text-gray-900">Troubleshooting</h2>

            <div className="mt-6 space-y-6">
              <div>
                <h3 className="text-base font-medium text-gray-900">
                  &quot;Organization Not Set Up&quot; error on the login page
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  No one from your company has completed the setup flow yet. An IT administrator from your organization needs to visit{' '}
                  <Link href="/setup" className="text-primary-600 hover:underline">/setup</Link>{' '}
                  to create the organization. Alternatively, you can{' '}
                  <Link href="/download" className="text-primary-600 hover:underline">sign up for an individual account</Link>{' '}
                  if your company doesn&apos;t use Keepr yet.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  &quot;Your organization requires an invitation&quot; error
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Your organization has JIT provisioning turned off. Ask your IT administrator to either invite you from the Users page, provision you via SCIM, or turn on JIT provisioning in Settings.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  &quot;Personal Microsoft accounts are not supported&quot;
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  You signed in with a personal account (Outlook.com, Hotmail, Live). Organization setup requires a <strong>work or school account</strong> tied to a Microsoft Entra ID tenant. Sign out and try again with your work email.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  &quot;Microsoft did not return your email address&quot;
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Your Azure AD tenant may not have the email claim enabled. Check that your user account in Entra ID has an email address set, and that the application registration includes the <code>email</code>, <code>profile</code>, and <code>openid</code> scopes.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  Team member can&apos;t sign in after setup
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Make sure they&apos;re using a work account from the same Microsoft tenant you used during setup. If they use a different tenant or a personal account, they won&apos;t be matched to your organization. Check the{' '}
                  <Link href="/dashboard/users" className="text-primary-600 hover:underline">Users page</Link>{' '}
                  to confirm they appear in the member list.
                </p>
              </div>

              <div>
                <h3 className="text-base font-medium text-gray-900">
                  I skipped admin consent &mdash; can I grant it later?
                </h3>
                <p className="mt-1 text-sm text-gray-700">
                  Yes. Go to{' '}
                  <Link href="/dashboard/settings" className="text-primary-600 hover:underline">Settings</Link>{' '}
                  and click <strong>Grant permissions with Microsoft</strong> under Desktop App Permissions. You can also grant consent from the{' '}
                  <a href="https://entra.microsoft.com" target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline">
                    Azure Entra admin center
                  </a>{' '}
                  under Enterprise Applications.
                </p>
              </div>
            </div>
          </section>

          {/* Footer */}
          <section className="mt-12 pt-6 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              Still need help?{' '}
              <a href="mailto:support@keeprcompliance.com" className="text-primary-600 hover:underline">
                Contact support
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
