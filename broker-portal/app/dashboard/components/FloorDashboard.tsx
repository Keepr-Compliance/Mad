/**
 * The portal floor's dashboard — BACKLOG-3080.
 *
 * What a brokerage agent, or the owner of a personal organization, sees at
 * /dashboard: a greeting, a way into the desktop app, and links to their own
 * support tickets and account. It reads NO data: a floor user's transactions
 * live in the desktop app, and nothing about the brokerage belongs here.
 *
 * Two desktop links, because /download starts an installer download on load:
 * the primary link opens the app someone already has; the secondary is for
 * someone who does not have it yet.
 */

import Link from 'next/link';
import { Headphones, Monitor, UserCircle } from 'lucide-react';
import { Card, PageHeader } from '@keepr/design-system';

/** Registered by the desktop app; opening it brings Keepr to the front. */
export const OPEN_DESKTOP_APP_HREF = 'keepr://focus';

export interface FloorDashboardProps {
  /** The same greeting the full dashboard uses (BACKLOG-3077). */
  headerTitle: string;
}

export function FloorDashboard({ headerTitle }: FloorDashboardProps) {
  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader title={headerTitle} subtitle="Your Keepr account" />

      <div className="space-y-6">
        <Card>
          <div className="flex items-start gap-4">
            <Monitor className="h-6 w-6 shrink-0 text-primary-600" aria-hidden="true" />
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Keepr runs on your computer. Your transactions stay in the desktop app.
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <a
                  href={OPEN_DESKTOP_APP_HREF}
                  className="inline-block rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-700"
                >
                  Open Keepr
                </a>
                <Link
                  href="/download"
                  className="text-sm font-medium text-primary-600 hover:text-primary-700"
                >
                  Don&apos;t have it yet? Download Keepr
                </Link>
              </div>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link href="/dashboard/support" className="block">
            <Card hover>
              <div className="flex items-center gap-3">
                <Headphones className="h-5 w-5 text-gray-500" aria-hidden="true" />
                <span className="text-sm font-medium text-gray-900">Support</span>
              </div>
            </Card>
          </Link>
          <Link href="/dashboard/account" className="block">
            <Card hover>
              <div className="flex items-center gap-3">
                <UserCircle className="h-5 w-5 text-gray-500" aria-hidden="true" />
                <span className="text-sm font-medium text-gray-900">My Account</span>
              </div>
            </Card>
          </Link>
        </div>
      </div>
    </div>
  );
}
