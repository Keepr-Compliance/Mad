'use client';

/**
 * EventsTimeline - Support Ticket Detail Sidebar
 *
 * Collapsible timeline showing ticket events: status changes,
 * assignments, priority changes, messages added, etc.
 * Chronological order (newest first).
 */

import { useState } from 'react';
import type { SupportTicketEvent } from '@/lib/support-types';

interface EventsTimelineProps {
  events: SupportTicketEvent[];
}

function getEventIcon(eventType: string): { symbol: string; color: string } {
  switch (eventType) {
    case 'created':
      return { symbol: '+', color: 'bg-green-100 text-green-700' };
    case 'status_changed':
      return { symbol: '\u25CF', color: 'bg-blue-100 text-blue-700' };
    case 'assigned':
      return { symbol: '\u263A', color: 'bg-purple-100 text-purple-700' };
    case 'priority_changed':
      return { symbol: '\u2691', color: 'bg-orange-100 text-orange-700' };
    case 'message_added':
      return { symbol: '\u2709', color: 'bg-gray-100 text-gray-600' };
    default:
      return { symbol: '\u2022', color: 'bg-gray-100 text-gray-600' };
  }
}

function getEventDescription(event: SupportTicketEvent): string {
  switch (event.event_type) {
    case 'created':
      return 'Ticket created';
    case 'status_changed':
      return event.old_value && event.new_value
        ? `Status: ${event.old_value} \u2192 ${event.new_value}`
        : `Status changed to ${event.new_value || 'unknown'}`;
    case 'assigned':
      return event.new_value
        ? `Assigned to ${event.new_value}`
        : 'Assignment changed';
    case 'priority_changed':
      return event.old_value && event.new_value
        ? `Priority: ${event.old_value} \u2192 ${event.new_value}`
        : `Priority changed to ${event.new_value || 'unknown'}`;
    case 'message_added':
      return 'Message added';
    default:
      return event.event_type.replace(/_/g, ' ');
  }
}

function formatEventTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

const INITIAL_VISIBLE = 5;

export function EventsTimeline({ events }: EventsTimelineProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  // Most recent first
  const sortedEvents = [...events].reverse();
  const visibleEvents = showAll ? sortedEvents : sortedEvents.slice(0, INITIAL_VISIBLE);
  const hasMore = sortedEvents.length > INITIAL_VISIBLE;

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
          Activity ({events.length})
        </span>
        <span className="text-xs text-gray-400">
          {expanded ? '\u25B2' : '\u25BC'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {events.length === 0 ? (
            <p className="text-xs text-gray-400">No activity recorded</p>
          ) : (
            <>
              {visibleEvents.map((event) => {
                const icon = getEventIcon(event.event_type);
                return (
                  <div key={event.id} className="flex items-start gap-2">
                    <span
                      className={`inline-flex items-center justify-center h-5 w-5 rounded-full text-xs font-bold shrink-0 ${icon.color}`}
                    >
                      {icon.symbol}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-gray-700">
                        {getEventDescription(event)}
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatEventTime(event.created_at)}
                      </p>
                    </div>
                  </div>
                );
              })}
              {hasMore && !showAll && (
                <button
                  onClick={() => setShowAll(true)}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                >
                  See all {sortedEvents.length} events
                </button>
              )}
              {showAll && hasMore && (
                <button
                  onClick={() => setShowAll(false)}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                >
                  Show less
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
