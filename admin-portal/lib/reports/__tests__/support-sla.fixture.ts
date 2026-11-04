/**
 * Support analytics fixture (BACKLOG-3651)
 *
 * Rows t01-t22 are TRANSCRIBED from production `support_tickets` on
 * 2026-10-29: one row per (status, has resolved_at, has closed_at,
 * has first_response_at, is assigned) shape, columns exactly as the report
 * selects them, timestamps in the PostgREST ISO form. Ids and assignees are
 * replaced with all-zero UUID patterns; no subject, requester or email.
 *
 * t23 and t24 are SYNTHETIC, in the real shape:
 * - t23: a reopened ticket (resolved -> in_progress is allowed by
 *   ALLOWED_TRANSITIONS) still carrying its old resolved_at.
 * - t24: a first response exactly 74h06m (4446 min) after creation, which
 *   formatDuration renders as "3d 2h".
 */

import type { SupportAgentUser, SupportTicketRow } from '../support-sla';

export const AGENT_A = '00000000-0000-0000-0000-00000000000a'; // pii-allow-uuid: invented all-zero pattern, not from any live row
export const AGENT_B = '00000000-0000-0000-0000-00000000000b'; // pii-allow-uuid: invented all-zero pattern, not from any live row

const id = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

function row(
  n: number,
  status: string,
  assignee_id: string | null,
  created_at: string,
  first_response_at: string | null,
  resolved_at: string | null,
  closed_at: string | null
): SupportTicketRow {
  return { id: id(n), status, assignee_id, created_at, first_response_at, resolved_at, closed_at };
}

export const TICKETS: SupportTicketRow[] = [
  row(1, 'assigned', AGENT_A, '2026-09-29T03:35:29.86044+00:00', '2026-10-04T15:45:15.149361+00:00', null, null),
  row(2, 'closed', AGENT_A, '2026-07-06T04:03:40.820589+00:00', null, null, '2026-07-06T04:10:43.070714+00:00'),
  row(3, 'closed', AGENT_A, '2026-10-16T17:56:54.045996+00:00', null, '2026-10-16T21:11:51.072598+00:00', '2026-10-16T21:17:56.840365+00:00'),
  row(4, 'closed', null, '2026-07-10T00:22:44.934089+00:00', null, '2026-07-10T02:35:29.173328+00:00', '2026-07-10T02:35:29.173328+00:00'),
  row(5, 'closed', null, '2026-07-31T04:56:26.562007+00:00', null, null, '2026-09-29T03:13:39.865809+00:00'),
  row(6, 'deleted', AGENT_A, '2026-03-22T16:50:04.022011+00:00', '2026-03-22T16:53:50.129461+00:00', null, null),
  row(7, 'deleted', null, '2026-07-20T19:31:50.162589+00:00', '2026-07-20T19:32:54.145308+00:00', null, null),
  row(8, 'deleted', AGENT_A, '2026-04-13T01:05:21.520967+00:00', '2026-04-13T01:06:45.763971+00:00', '2026-04-13T01:16:51.468544+00:00', null),
  row(9, 'deleted', null, '2026-10-13T18:25:35.796166+00:00', null, null, null),
  row(10, 'deleted', AGENT_A, '2026-03-20T20:12:49.208617+00:00', null, null, '2026-03-20T20:23:39.294707+00:00'),
  row(11, 'in_progress', AGENT_A, '2026-04-11T01:58:10.543576+00:00', null, null, null),
  row(12, 'in_progress', null, '2026-07-18T19:52:23.55558+00:00', '2026-07-18T20:28:45.502783+00:00', null, null),
  row(13, 'new', null, '2026-07-20T19:31:08.613081+00:00', '2026-07-20T19:33:02.591016+00:00', null, null),
  row(14, 'new', AGENT_B, '2026-03-20T01:45:06.536556+00:00', '2026-03-24T16:03:55.712982+00:00', null, null),
  row(15, 'new', AGENT_B, '2026-03-20T01:58:19.904401+00:00', null, null, null),
  row(16, 'new', null, '2026-10-29T23:16:26.229563+00:00', null, null, null),
  row(17, 'pending', null, '2026-03-18T16:46:58.260769+00:00', null, null, null),
  row(18, 'pending', null, '2026-03-18T16:14:27.805422+00:00', '2026-03-18T16:25:30.077803+00:00', null, null),
  row(19, 'pending', AGENT_A, '2026-04-16T22:48:56.470547+00:00', '2026-04-17T17:24:50.230873+00:00', null, null),
  row(20, 'pending', AGENT_A, '2026-03-20T01:58:19.904401+00:00', null, null, null),
  row(21, 'resolved', null, '2026-07-26T01:38:04.497921+00:00', null, '2026-07-29T16:25:59.138434+00:00', null),
  row(22, 'resolved', AGENT_A, '2026-10-15T19:01:28.091573+00:00', '2026-10-15T19:54:31.609245+00:00', '2026-10-16T21:20:27.98554+00:00', null),
  // synthetic, see header
  row(23, 'in_progress', AGENT_A, '2026-10-01T00:00:00+00:00', null, '2026-10-02T00:00:00+00:00', null),
  row(24, 'assigned', AGENT_B, '2026-10-20T00:00:00+00:00', '2026-10-23T02:06:00+00:00', null, null),
];

export const ticketId = id;

export const USERS: SupportAgentUser[] = [
  { id: AGENT_A, email: 'agent-a@example.com', display_name: 'Agent A', first_name: null, last_name: null },
  { id: AGENT_B, email: 'agent-b@example.com', display_name: null, first_name: null, last_name: null },
];

/** Fixed clock: the 30-day period is [2026-09-30, 2026-10-30). */
export const NOW = new Date('2026-10-30T00:00:00.000Z');
