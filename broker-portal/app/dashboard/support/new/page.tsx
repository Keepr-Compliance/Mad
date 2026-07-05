'use client';

/**
 * New Ticket Page - Dashboard Layout
 *
 * Renders the ticket form inside the dashboard layout so authenticated
 * users keep the nav bar visible. The public /support/new route remains
 * for unauthenticated visitors.
 */

import { Card, PageHeader } from '@keepr/design-system';
import { TicketForm } from '@/app/support/components/TicketForm';

export default function DashboardNewTicketPage() {
  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="Submit a Support Request"
        subtitle="Fill out the form below and we will get back to you as soon as possible."
      />

      <Card>
        <TicketForm />
      </Card>
    </div>
  );
}
