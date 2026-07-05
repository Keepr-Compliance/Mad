'use client';

/**
 * TicketList - Customer Ticket List
 *
 * Shows tickets for the current user (authenticated) or by email lookup (unauthenticated).
 *
 * TASK-2287: For authenticated users we do NOT pass p_requester_email to the
 * support_list_tickets RPC.  That parameter is treated as an agent-only filter
 * (see 20260313_support_security_fixes migration).  The RPC's audience filter
 * already restricts non-agent callers to their own tickets via auth.uid() and
 * the caller's email from auth.users -- so passing it explicitly caused
 * the condition `(v_is_agent AND t.requester_email = p_requester_email)` to
 * evaluate to FALSE, hiding all tickets from non-agent users.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Alert, buttonClasses } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';
import { listTickets } from '@/lib/support-queries';
import type { SupportTicket } from '@/lib/support-types';
import { STATUS_LABELS, STATUS_COLORS, PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/support-types';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return 'Just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TicketList() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  // readyToLoad flips true once auth check completes (authenticated) or once
  // a manual email lookup is submitted (unauthenticated).
  const [readyToLoad, setReadyToLoad] = useState(false);

  // Check auth on mount
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user?.email) {
        setUserEmail(user.email);
        setIsAuthenticated(true);
        // Trigger ticket load without passing email as p_requester_email
        setReadyToLoad(true);
      } else {
        setLoading(false);
      }
    });
  }, []);

  // Load tickets once ready
  useEffect(() => {
    if (!readyToLoad) return;

    setLoading(true);
    setError(null);
    // For authenticated users, pass no requester email -- the RPC audience
    // filter handles scoping to the caller's own tickets.
    listTickets(isAuthenticated ? undefined : (userEmail ?? undefined))
      .then((data) => {
        setTickets(data.tickets);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load tickets');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [readyToLoad, isAuthenticated, userEmail]);

  // Unauthenticated: prompt to log in or submit a new ticket
  if (!isAuthenticated && !readyToLoad) {
    return (
      <div>
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <p className="text-gray-500 text-sm mb-4">
            Log in to view your support tickets, or submit a new request below.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/login?redirect=/support" className={buttonClasses('primary')}>
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

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-white rounded-lg border border-gray-200 p-4 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
            <div className="h-3 bg-gray-200 rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <Alert variant="error">{error}</Alert>;
  }

  if (tickets.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
        <p className="text-gray-500 text-sm mb-4">
          No tickets found{userEmail && !isAuthenticated ? ` for ${userEmail}` : ''}.
        </p>
        <Link
          href="/support/new"
          className="text-sm font-medium text-primary-600 hover:text-primary-700"
        >
          Create a new ticket
        </Link>
      </div>
    );
  }

  return (
    <div>
      {userEmail && !isAuthenticated && (
        <p className="text-sm text-gray-500 mb-3">Showing tickets for {userEmail}</p>
      )}
      <div className="space-y-3">
        {tickets.map((ticket) => (
          <Link
            key={ticket.id}
            href={`/dashboard/support/${ticket.id}`}
            className="block bg-white rounded-lg border border-gray-200 p-4 hover:border-primary-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-gray-400 font-mono">#{ticket.ticket_number}</span>
                  <h3 className="text-sm font-medium text-gray-900 truncate">{ticket.subject}</h3>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  {ticket.category_name && <span>{ticket.category_name}</span>}
                  <span>{formatDate(ticket.created_at)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[ticket.priority]}`}
                >
                  {PRIORITY_LABELS[ticket.priority]}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[ticket.status]}`}
                >
                  {STATUS_LABELS[ticket.status]}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
