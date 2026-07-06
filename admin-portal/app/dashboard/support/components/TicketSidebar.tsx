'use client';

/**
 * TicketSidebar - Support Ticket Detail
 *
 * Right sidebar showing ticket metadata: status, priority, category,
 * assignee, requester info, timestamps, participants, and events.
 * Includes controls for status transitions, assignment, and priority changes.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { User, Calendar, AlertCircle, ExternalLink } from 'lucide-react';
import { updateTicketStatus, updateTicketPriority, updateTicketCategory, assignTicket, getAssignableAgents, getCategories } from '@/lib/support-queries';
import type { AssignableAgent } from '@/lib/support-queries';
import type { SupportCategory } from '@/lib/support-types';
import type {
  SupportTicket,
  TicketStatus,
  TicketPriority,
  PendingReason,
  SupportTicketParticipant,
} from '@/lib/support-types';
import {
  ALLOWED_TRANSITIONS,
  STATUS_LABELS,
  PRIORITY_LABELS,
} from '@/lib/support-types';
import { StatusBadge } from './StatusBadge';
import { ParticipantsPanel } from './ParticipantsPanel';
import { RelatedTicketsPanel } from './RelatedTicketsPanel';
import { BacklogLinksPanel } from './BacklogLinksPanel';
import { EmailLogPanel } from './EmailLogPanel';
import { formatTimestamp } from '@/lib/format';

interface TicketSidebarProps {
  ticket: SupportTicket;
  participants: SupportTicketParticipant[];
  onTicketUpdated: () => void;
}

export function TicketSidebar({ ticket, participants, onTicketUpdated }: TicketSidebarProps) {
  const [agents, setAgents] = useState<AssignableAgent[]>([]);
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [updatingPriority, setUpdatingPriority] = useState(false);
  const [updatingCategory, setUpdatingCategory] = useState(false);
  const [updatingAssignee, setUpdatingAssignee] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<TicketStatus | ''>('');
  const [selectedPriority, setSelectedPriority] = useState<TicketPriority>(ticket.priority);
  const [selectedCategory, setSelectedCategory] = useState<string>(ticket.category_id || '');
  const [selectedAssignee, setSelectedAssignee] = useState<string>(ticket.assignee_id || '');
  const [showPendingReason, setShowPendingReason] = useState(false);
  const [pendingReason, setPendingReason] = useState<PendingReason>('customer');
  const [error, setError] = useState<string | null>(null);

  // Suppress unused variable warnings for phase-1 features not yet wired
  void updatingAssignee;

  useEffect(() => {
    getAssignableAgents().then(setAgents).catch(() => {});
    getCategories().then((cats) => setCategories(cats.filter((c) => !c.parent_id))).catch(() => {});
  }, []);

  const allowedTransitions = ALLOWED_TRANSITIONS[ticket.status] || [];

  async function handleStatusSave() {
    if (!selectedStatus) return;
    if (selectedStatus === 'pending') {
      setShowPendingReason(true);
      return;
    }
    setUpdatingStatus(true);
    setError(null);
    try {
      await updateTicketStatus(ticket.id, selectedStatus);
      setSelectedStatus('');
      onTicketUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handlePrioritySave() {
    if (selectedPriority === ticket.priority) return;
    setUpdatingPriority(true);
    setError(null);
    try {
      await updateTicketPriority(ticket.id, selectedPriority);
      onTicketUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update priority');
    } finally {
      setUpdatingPriority(false);
    }
  }

  async function handleCategorySave() {
    const newCategoryId = selectedCategory || null;
    if (newCategoryId === (ticket.category_id || null)) return;
    setUpdatingCategory(true);
    setError(null);
    try {
      await updateTicketCategory(ticket.id, newCategoryId);
      onTicketUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update category');
    } finally {
      setUpdatingCategory(false);
    }
  }

  async function handlePendingConfirm() {
    setUpdatingStatus(true);
    setError(null);
    try {
      await updateTicketStatus(ticket.id, 'pending', pendingReason);
      setShowPendingReason(false);
      onTicketUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleAssigneeSave() {
    if (!selectedAssignee || selectedAssignee === (ticket.assignee_id || '')) return;
    setUpdatingAssignee(true);
    setError(null);
    try {
      await assignTicket(ticket.id, selectedAssignee);
      onTicketUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign ticket');
    } finally {
      setUpdatingAssignee(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
      {/* Error display */}
      {error && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-200">
          <div className="flex items-center gap-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        </div>
      )}

      {/* Status */}
      <div className="px-4 py-3">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
          Status
        </label>
        <div className="flex items-center gap-2 mb-2">
          <StatusBadge status={ticket.status} />
        </div>
        {allowedTransitions.length > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value as TicketStatus)}
              className="flex-1 text-sm text-gray-900 border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">Change status...</option>
              {allowedTransitions.map((nextStatus) => (
                <option key={nextStatus} value={nextStatus}>
                  {STATUS_LABELS[nextStatus]}
                </option>
              ))}
            </select>
            <button
              onClick={handleStatusSave}
              disabled={!selectedStatus || updatingStatus}
              className="text-xs px-3 py-1.5 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {updatingStatus ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
        {/* Pending reason dialog */}
        {showPendingReason && (
          <div className="mt-2 p-2 bg-orange-50 border border-orange-200 rounded-md">
            <label className="text-xs font-medium text-orange-700 block mb-1">
              Pending Reason
            </label>
            <select
              value={pendingReason}
              onChange={(e) => setPendingReason(e.target.value as PendingReason)}
              className="w-full text-xs text-gray-900 border border-orange-300 rounded px-2 py-1 mb-2"
            >
              <option value="customer">Waiting on Customer</option>
              <option value="vendor">Waiting on Vendor</option>
              <option value="internal">Internal</option>
            </select>
            <div className="flex gap-1">
              <button
                onClick={handlePendingConfirm}
                disabled={updatingStatus}
                className="text-xs px-2 py-1 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowPendingReason(false)}
                className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Priority */}
      <div className="px-4 py-3">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
          Priority
        </label>
        <div className="flex items-center gap-2">
          <select
            value={selectedPriority}
            onChange={(e) => setSelectedPriority(e.target.value as TicketPriority)}
            className="flex-1 text-sm text-gray-900 border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {(Object.entries(PRIORITY_LABELS) as [TicketPriority, string][]).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <button
            onClick={handlePrioritySave}
            disabled={selectedPriority === ticket.priority || updatingPriority}
            className="text-xs px-3 py-1.5 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {updatingPriority ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Assignee */}
      <div className="px-4 py-3">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
          Assignee
        </label>
        <div className="flex items-center gap-2">
          <select
            value={selectedAssignee}
            onChange={(e) => setSelectedAssignee(e.target.value)}
            className="flex-1 text-sm text-gray-900 border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50"
          >
            <option value="">Unassigned</option>
            {agents.map((agent) => (
              <option key={agent.user_id} value={agent.user_id}>
                {agent.display_name} ({agent.role_name})
              </option>
            ))}
          </select>
          <button
            onClick={handleAssigneeSave}
            disabled={!selectedAssignee || selectedAssignee === (ticket.assignee_id || '') || updatingAssignee}
            className="text-xs px-3 py-1.5 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {updatingAssignee ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Category */}
      <div className="px-4 py-3">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
          Category
        </label>
        <div className="flex items-center gap-2">
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="flex-1 text-sm text-gray-900 border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">Uncategorized</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <button
            onClick={handleCategorySave}
            disabled={(selectedCategory || null) === (ticket.category_id || null) || updatingCategory}
            className="text-xs px-3 py-1.5 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {updatingCategory ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Requester */}
      <div className="px-4 py-3">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
          Requester
        </label>
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-gray-200 flex items-center justify-center">
            <User className="h-4 w-4 text-gray-500" />
          </div>
          {ticket.requester_id ? (
            <Link
              href={`/dashboard/users/${ticket.requester_id}`}
              className="group flex items-center gap-1 min-w-0"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-primary-600 group-hover:underline truncate">
                  {ticket.requester_name}
                </div>
                <div className="text-xs text-gray-500 group-hover:text-primary-500 truncate">
                  {ticket.requester_email}
                </div>
              </div>
              <ExternalLink className="h-3 w-3 text-gray-400 group-hover:text-primary-500 shrink-0" />
            </Link>
          ) : (
            <div>
              <div className="text-sm font-medium text-gray-900">{ticket.requester_name}</div>
              <div className="text-xs text-gray-500">{ticket.requester_email}</div>
            </div>
          )}
        </div>
      </div>

      {/* Participants */}
      <ParticipantsPanel
        ticketId={ticket.id}
        participants={participants}
        onUpdated={onTicketUpdated}
      />

      {/* Related Tickets */}
      <RelatedTicketsPanel
        ticketId={ticket.id}
        onTicketUpdated={onTicketUpdated}
      />

      {/* Backlog Links */}
      <BacklogLinksPanel ticketId={ticket.id} onUpdate={onTicketUpdated} />

      {/* Email Delivery Log */}
      {ticket.requester_email && (
        <EmailLogPanel recipientEmail={ticket.requester_email} />
      )}

      {/* Timestamps */}
      <div className="px-4 py-3">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
          Dates
        </label>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Calendar className="h-3 w-3" />
            Created: {formatTimestamp(ticket.created_at)}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Calendar className="h-3 w-3" />
            Updated: {formatTimestamp(ticket.updated_at)}
          </div>
          {ticket.first_response_at && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Calendar className="h-3 w-3" />
              First response: {formatTimestamp(ticket.first_response_at)}
            </div>
          )}
          {ticket.resolved_at && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Calendar className="h-3 w-3" />
              Resolved: {formatTimestamp(ticket.resolved_at)}
            </div>
          )}
        </div>
      </div>

      {/* Ticket Info */}
      <div className="px-4 py-3">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
          Details
        </label>
        <div className="space-y-1 text-xs text-gray-500">
          <div>Source: {ticket.source_channel.replace('_', ' ')}</div>
          {ticket.reopened_count > 0 && (
            <div>Reopened: {ticket.reopened_count} time{ticket.reopened_count > 1 ? 's' : ''}</div>
          )}
          {ticket.pending_reason && (
            <div>Pending reason: {ticket.pending_reason}</div>
          )}
        </div>
      </div>
    </div>
  );
}
