/**
 * New Ticket Page - Broker Portal
 *
 * Ticket submission form accessible without authentication.
 */

import { Card, PageHeader } from '@keepr/design-system';
import { TicketForm } from '../components/TicketForm';

export default function NewTicketPage() {
  return (
    <div>
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
