/**
 * Legal Page
 *
 * Combined Terms of Service and Privacy Policy page.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@keepr/ui';

export const metadata: Metadata = {
  title: 'Terms of Service & Privacy Policy - Keepr',
  description: 'Terms of Service and Privacy Policy for Keepr by Blue Spaces LLC.',
};

export default function LegalPage() {
  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <Link href="/" className="text-3xl font-bold text-gray-900"><Wordmark /></Link>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Keepr &mdash; Terms of Service &amp; Privacy Policy</h1>
          <p className="text-sm text-gray-500 mb-8">Effective Date: February 20, 2026</p>

          <div className="space-y-6 text-gray-700 text-sm leading-relaxed">
            <p>
              These Terms are a binding agreement between you and Keepr (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) for your use of the Keepr application and related services (the &quot;Service&quot;).
            </p>
            <p>
              By clicking &quot;I Agree,&quot; downloading, installing, or using the Service, you agree to these Terms. If you do not agree, do not use the Service.
            </p>

            <hr className="border-gray-200" />

            {/* Section 1 */}
            <div id="terms">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">1. Who Can Use the Service</h2>
              <p className="mb-3">
                The Service is for real estate professionals in the United States who are at least 18 years old &mdash; including licensed agents, brokers, transaction coordinators, and brokerage office staff. By using the Service, you confirm that you meet these requirements and are using it for legitimate real estate transaction activities.
              </p>
              <p>
                You must create an account using Google or Microsoft sign-in and keep your credentials secure. You are responsible for all activity under your account.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 2 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">2. License and Subscription</h2>
              <p className="mb-3">
                The Service is licensed to you, not sold. We grant you a limited, non-exclusive, non-transferable, revocable license to use the Service on one (1) device, subject to your subscription tier and payment of applicable fees.
              </p>
              <p className="mb-3">
                Subscription fees are charged in advance (monthly or annually) and are non-refundable. You may cancel at any time and retain access through the end of your billing period. We may change fees with 30 days&apos; notice.
              </p>
              <p>
                Each plan includes a storage limit for attachments and documents. If you exceed your limit, we may restrict uploads until you upgrade or reduce usage. We are not responsible for data loss or issues caused by exceeding your plan limits.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 3 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">3. What the Service Is (and Isn&apos;t) For</h2>
              <p className="mb-3">
                Keepr is a productivity tool for organizing, auditing, and archiving real estate transaction communications and documents. That&apos;s it.
              </p>
              <p>
                It is not: a legal compliance system, a substitute for legal counsel, a general email client, a financial reporting tool, or a regulatory archival system. Any reliance on the Service for compliance or legal purposes is at your own risk.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 4 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">4. No Resale</h2>
              <p>
                Your license is for your own professional use only. You may not resell, sublicense, lease, white-label, rebrand, or redistribute the Service or any of its outputs. You may not use it to provide services to third parties or bundle it with other products. Violating this is grounds for immediate termination without refund.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 5 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">5. Your Data</h2>
              <p className="mb-3">
                You own your data. We don&apos;t.
              </p>
              <p className="mb-3">
                We need a license to process it in order to run the Service &mdash; so by using the Service, you grant us a limited license to access and process your data solely to provide the Service, run AI detection features, create anonymized datasets for model improvement, and comply with law. We may use anonymized, non-identifiable data to improve our models.
              </p>
              <p>
                You can export your data at any time. Individual tier users keep everything locally on their device &mdash; cancellation doesn&apos;t affect your local data. For Team and Enterprise users with data in the broker portal, you&apos;ll have 30 days after cancellation to export before we delete it from our cloud systems.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 6 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">6. AI Features</h2>
              <p>
                The AI Detection feature sends your email content to third-party AI providers (currently OpenAI and Anthropic) for transaction classification. You can use our API tokens or your own. AI results are provided &quot;as-is&quot; &mdash; they may contain errors, and you are responsible for reviewing them.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 7 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">7. Audit Packages &mdash; Your Responsibility</h2>
              <p>
                You are solely responsible for verifying the completeness and accuracy of any audit package or output generated through the Service. The Service helps you organize data &mdash; it does not guarantee that an audit package is complete or compliant. AI detection may miss things or misclassify them. Review everything before relying on it.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 8 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">8. Third-Party Platforms</h2>
              <p>
                The Service integrates with Google, Microsoft, and Apple platforms. We are not responsible for their availability or changes they make. If a third-party platform update breaks something in the Service, we&apos;ll make reasonable efforts to fix it, but we can&apos;t guarantee a timeline. We have no liability for issues caused by third-party platform changes. Your remedy is to cancel your subscription.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 9 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">9. No Warranties</h2>
              <p>
                The Service is provided &quot;as is&quot; and &quot;as available.&quot; We don&apos;t guarantee uptime, accuracy, compatibility, or error-free operation. We may add, change, or remove features at any time. Beta or early-access features may have bugs and carry no commitments.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 10 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">10. Limitation of Liability</h2>
              <p>
                We are not liable for any indirect, incidental, special, consequential, or punitive damages. Our total liability for any claim related to the Service is limited to the amount you actually paid us in the 12 months before the claim. That&apos;s the maximum &mdash; the cost of your subscription.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 11 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">11. Indemnification</h2>
              <p>
                You agree to indemnify and hold us harmless from claims arising out of your use of the Service, the data you process through it, or your violation of these Terms or any law.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 12 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">12. Termination</h2>
              <p>
                You can cancel anytime. We can suspend or terminate your access if you breach these Terms, fail to pay, or if required by law. We may also discontinue the Service with 60 days&apos; notice.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 13 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">13. Disputes</h2>
              <p>
                Any disputes will be resolved by binding arbitration through the American Arbitration Association in Florida. You waive the right to participate in class actions. These Terms are governed by Florida law.
              </p>
            </div>

            <hr className="border-gray-200" />

            {/* Section 14 - Privacy */}
            <div id="privacy">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">14. Privacy</h2>

              <div className="space-y-5">
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">What Stays on Your Device</h3>
                  <p>
                    Keepr uses a local-first architecture. For Individual tier users, your sensitive data &mdash; emails, messages, transactions, contacts, attachments &mdash; stays on your device in an encrypted database. It doesn&apos;t leave your device unless you explicitly send it (submitting to the broker portal or using AI detection).
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">What We Store in the Cloud</h3>
                  <p>
                    Account info (email, name), subscription status, device registrations, usage analytics, and audit logs. For Team/Enterprise users who submit transactions to the broker portal, we also store the submitted transaction data.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">AI Providers</h3>
                  <p>
                    When AI Detection is on, email content goes to our AI providers for processing. We use configurations that limit provider-side use of your data where available.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">Third-Party Processors</h3>
                  <p>
                    We use third-party providers for cloud infrastructure, email API access (Google, Microsoft), AI processing (OpenAI, Anthropic), hosting, and analytics. We don&apos;t sell your personal information.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">Data Security</h3>
                  <p>
                    We use industry-standard encryption at rest and in transit, secure credential storage, and OAuth-based authentication. No method is 100% secure, and we can&apos;t guarantee absolute security.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">Data Retention</h3>
                  <p>
                    We keep data only as long as reasonably necessary. Cloud transaction records follow real estate industry norms. Analytics data is kept for a limited period. Your locally stored data is under your control.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">Your Privacy Rights</h3>
                  <p>
                    If you&apos;re a resident of California, Colorado, Connecticut, Utah, or Virginia, you have rights under your state&apos;s privacy law &mdash; including the right to know what we collect, request deletion, and opt out of data sales (we don&apos;t sell data, but you can still ask). Contact{' '}
                    <a href="mailto:privacy@keeprcompliance.com" className="text-primary-600 hover:text-primary-700">
                      privacy@keeprcompliance.com
                    </a>{' '}
                    to exercise your rights.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">Breach Notification</h3>
                  <p>
                    If there&apos;s a breach affecting your data in our cloud systems, we&apos;ll notify you as required by law. Since most data stays on your device, a cloud breach would primarily affect account and analytics information.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">Children</h3>
                  <p>
                    The Service is for adults (18+). We don&apos;t knowingly collect data from minors.
                  </p>
                </div>
              </div>
            </div>

            <hr className="border-gray-200" />

            {/* Section 15 */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">15. General</h2>
              <p>
                We can update these Terms with 30 days&apos; notice for material changes. If any provision is unenforceable, the rest still applies. You can&apos;t transfer your account. We can assign ours in a merger or acquisition. Neither of us waives rights by not enforcing them immediately. We&apos;re not liable for events beyond our control.
              </p>
            </div>
          </div>
        </div>

        <div className="text-center text-sm text-gray-400 pb-8">
          &copy; {new Date().getFullYear()} Blue Spaces LLC. All rights reserved.
        </div>
      </div>
    </div>
  );
}
