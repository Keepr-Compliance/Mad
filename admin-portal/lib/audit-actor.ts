/**
 * Who an audit-log row is attributed to (BACKLOG-3846 / BACKLOG-3136).
 *
 * actor_id is NULL only for a service-role action. The Stripe webhook's dispute
 * suspension is one; it records metadata.source = 'stripe_webhook'.
 */
export interface AuditActorFields {
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  metadata: Record<string, unknown> | null;
}

export function auditActorLabel(entry: AuditActorFields): string {
  if (entry.actor_name) return entry.actor_name;
  if (entry.actor_email) return entry.actor_email;
  if (entry.actor_id === null) {
    return entry.metadata?.source === 'stripe_webhook' ? 'System (Stripe)' : 'System';
  }
  return 'Unknown';
}
