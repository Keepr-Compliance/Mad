/**
 * New Ticket Page - Dashboard Layout
 *
 * Renders the ticket form inside the dashboard layout so authenticated
 * users keep the nav bar visible. The public /support/new route remains
 * for unauthenticated visitors.
 *
 * BACKLOG-3080: `?preset=<key>` opens the form pre-filled from a fixed entry in
 * lib/support/ticketPresets.ts. Only the key is read; no other parameter.
 */

import { Card, PageHeader } from '@keepr/design-system';
import { TicketForm } from '@/app/support/components/TicketForm';
import { resolveTicketPreset } from '@/lib/support/ticketPresets';

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DashboardNewTicketPage({ searchParams }: PageProps) {
  const preset = resolveTicketPreset(await searchParams);

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="Submit a Support Request"
        subtitle="Fill out the form below and we will get back to you as soon as possible."
      />

      <Card>
        <TicketForm preset={preset} />
      </Card>
    </div>
  );
}
