'use client';

/**
 * Public Support Landing Page - Broker Portal
 *
 * Redirects authenticated users to /dashboard/support.
 * Unauthenticated users see option to log in or submit a new ticket.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { buttonClasses, PageHeader, Spinner } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';

export default function SupportPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        router.replace('/dashboard/support');
      } else {
        setChecking(false);
      }
    });
  }, [router]);

  if (checking) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Support" subtitle="Get help from the Keepr team" />

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <p className="text-gray-500 text-sm mb-4">
          Log in to view your support tickets, or submit a new request below.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link href="/login?redirect=/dashboard/support" className={buttonClasses('primary')}>
            Log In
          </Link>
          <Link href="/support/new" className={buttonClasses('secondary')}>
            Submit a New Ticket
          </Link>
        </div>
      </div>
    </div>
  );
}
