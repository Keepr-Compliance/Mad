'use client';

/**
 * Support Tickets Page - Broker Portal Dashboard
 *
 * Shows the customer's tickets within the dashboard layout.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Plus } from 'lucide-react';
// PageHeader is Tier-2 (no @keepr/ui equivalent yet).
import { PageHeader } from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { TicketList } from '@/app/support/components/TicketList';

function SuccessBanner() {
  const searchParams = useSearchParams();
  const success = searchParams.get('success');

  if (!success) return null;

  return (
    <AlertBanner variant="success" className="mb-6">
      Your ticket has been submitted successfully. We will get back to you soon.
    </AlertBanner>
  );
}

export default function DashboardSupportPage() {
  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Support"
        subtitle="View and track your support requests"
        actions={
          <Button onClick={() => window.dispatchEvent(new Event('open-support-widget'))}>
            <Plus className="h-4 w-4" />
            New Ticket
          </Button>
        }
      />

      <Suspense fallback={null}>
        <SuccessBanner />
      </Suspense>

      <TicketList />
    </div>
  );
}
