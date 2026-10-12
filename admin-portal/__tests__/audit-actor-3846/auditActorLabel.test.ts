import { auditActorLabel } from '@/lib/audit-actor';

// Shape: admin_get_audit_logs rows (LEFT JOIN users), as AuditLogContent types them.
const base = { actor_id: 'u-1', actor_name: null, actor_email: null, metadata: null };

describe('auditActorLabel (BACKLOG-3846)', () => {
  it('a Stripe webhook action with no actor reads "System (Stripe)"', () => {
    expect(auditActorLabel({ ...base, actor_id: null, metadata: { source: 'stripe_webhook' } })).toBe('System (Stripe)');
  });
  it('another actorless action reads "System"', () => {
    expect(auditActorLabel({ ...base, actor_id: null, metadata: {} })).toBe('System');
  });
  it('a known actor keeps name, then email', () => {
    expect(auditActorLabel({ ...base, actor_name: 'Ann', actor_email: 'a@example.test' })).toBe('Ann');
    expect(auditActorLabel({ ...base, actor_email: 'a@example.test' })).toBe('a@example.test');
  });
  it('an actor id with no user row stays "Unknown"', () => {
    expect(auditActorLabel(base)).toBe('Unknown');
  });
});
