/**
 * BACKLOG-3850: the outbox kind that ends the personal Agent plan at a brokerage join. Its own
 * module so the nightly reconcile can enqueue it without loading the handler's email code.
 * The database writes the same literal (migration 20261111130000).
 */
export const JOIN_CANCEL_KIND = 'cancel_agent_on_brokerage_join';
