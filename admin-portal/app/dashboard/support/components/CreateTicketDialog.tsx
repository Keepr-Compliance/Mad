'use client';

/**
 * CreateTicketDialog - Support Dashboard
 *
 * Modal dialog for agents to create tickets on behalf of customers.
 * Features: requester search autocomplete, auto-fill, recent tickets panel,
 * phone number, preferred contact method, category/priority/subcategory.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Search, Loader2, AlertTriangle, ExternalLink, Info } from 'lucide-react';
import { Button, Label, Badge } from '@keepr/design-system';
import {
  createTicket,
  notifyTicketCreated,
  getCategories,
  buildCategoryTree,
  searchRequesters,
  getRequesterRecentTickets,
} from '@/lib/support-queries';
import type {
  TicketPriority,
  SupportCategory,
  RequesterSearchResult,
  RecentTicket,
  PreferredContact,
} from '@/lib/support-types';
import { PRIORITY_LABELS, STATUS_COLORS } from '@/lib/support-types';

interface CreateTicketDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const INPUT_CLASS =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export function CreateTicketDialog({ open, onClose, onCreated }: CreateTicketDialogProps) {
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RequesterSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedRequester, setSelectedRequester] = useState<RequesterSearchResult | null>(null);
  const [manualEntry, setManualEntry] = useState(false);

  // Recent tickets state
  const [recentTickets, setRecentTickets] = useState<RecentTicket[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  // Form fields
  const [requesterEmail, setRequesterEmail] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [requesterPhone, setRequesterPhone] = useState('');
  const [preferredContact, setPreferredContact] = useState<PreferredContact>('email');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [categoryId, setCategoryId] = useState<string>('');
  const [subcategoryId, setSubcategoryId] = useState<string>('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load categories when dialog opens
  useEffect(() => {
    if (open) {
      getCategories().then((cats) => setCategories(buildCategoryTree(cats)));
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (searchQuery.length < 2) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchRequesters(searchQuery);
        setSearchResults(results);
        setShowResults(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchQuery]);

  // Load recent tickets when a requester is selected
  useEffect(() => {
    if (!selectedRequester) {
      setRecentTickets([]);
      return;
    }

    let cancelled = false;
    setLoadingRecent(true);
    getRequesterRecentTickets(selectedRequester.email)
      .then((tickets) => {
        if (!cancelled) setRecentTickets(tickets);
      })
      .catch(() => {
        if (!cancelled) setRecentTickets([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingRecent(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRequester]);

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const disclaimer = selectedCategory?.metadata?.disclaimer as string | undefined;

  const openTicketCount = recentTickets.filter(
    (t) => t.status !== 'resolved' && t.status !== 'closed'
  ).length;

  const resetForm = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setShowResults(false);
    setSelectedRequester(null);
    setManualEntry(false);
    setRecentTickets([]);
    setRequesterEmail('');
    setRequesterName('');
    setRequesterPhone('');
    setPreferredContact('email');
    setSubject('');
    setDescription('');
    setPriority('normal');
    setCategoryId('');
    setSubcategoryId('');
    setError(null);
  }, []);

  function handleSelectRequester(result: RequesterSearchResult) {
    setSelectedRequester(result);
    setRequesterEmail(result.email);
    setRequesterName(result.name);
    setRequesterPhone(result.phone || '');
    setManualEntry(false);
    setShowResults(false);
    setSearchQuery('');
  }

  function handleManualEntry() {
    setManualEntry(true);
    setSelectedRequester(null);
    setRecentTickets([]);
    setShowResults(false);
    setSearchQuery('');
  }

  function handleClearSelection() {
    setSelectedRequester(null);
    setManualEntry(false);
    setRecentTickets([]);
    setRequesterEmail('');
    setRequesterName('');
    setRequesterPhone('');
    setSearchQuery('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const ticket = await createTicket({
        subject,
        description,
        priority,
        requester_email: requesterEmail,
        requester_name: requesterName,
        requester_phone: requesterPhone || undefined,
        preferred_contact: preferredContact,
        category_id: categoryId || undefined,
        subcategory_id: subcategoryId || undefined,
        source_channel: 'admin_created',
      });

      // Fire-and-forget: send confirmation email to requester.
      // NOTE: Server-side trigger also sends this via send-ticket-confirmation
      // edge function (BACKLOG-1573). This client call is kept as a fallback.
      const brokerPortalUrl =
        process.env.NEXT_PUBLIC_BROKER_PORTAL_URL || 'https://app.keeprcompliance.com';
      notifyTicketCreated(
        ticket.id,
        { subject, ticket_number: ticket.ticket_number, requester_email: requesterEmail },
        brokerPortalUrl
      );

      resetForm();
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Create Ticket</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Requester Search / Selection */}
          {!selectedRequester && !manualEntry ? (
            <div>
              <Label required>Search for Requester</Label>
              <div className="relative" ref={dropdownRef}>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => {
                      if (searchResults.length > 0) setShowResults(true);
                    }}
                    onBlur={() => {
                      // Small delay so click on result registers
                      setTimeout(() => setShowResults(false), 200);
                    }}
                    className={`${INPUT_CLASS} pl-9`}
                    placeholder="Search by name, email, or organization..."
                    autoFocus
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 animate-spin" />
                  )}
                </div>

                {/* Search Results Dropdown */}
                {showResults && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                    {searchResults.length === 0 && !searching ? (
                      <div className="px-4 py-3 text-sm text-gray-500">
                        No results found for &quot;{searchQuery}&quot;
                      </div>
                    ) : (
                      searchResults.map((result) => (
                        <button
                          key={result.user_id}
                          type="button"
                          className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleSelectRequester(result);
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-gray-900">
                                {result.name}
                              </span>
                              <span className="text-sm text-gray-500"> -- {result.email}</span>
                              {result.organization_name && (
                                <span className="text-sm text-gray-400">
                                  {' '}
                                  -- {result.organization_name}
                                </span>
                              )}
                            </div>
                            {result.open_ticket_count > 0 && (
                              <span className="ml-2 flex-shrink-0 text-xs text-orange-600 font-medium">
                                {result.open_ticket_count} open
                              </span>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleManualEntry}
                className="mt-2 text-sm text-primary-600 hover:text-primary-800 underline"
              >
                No match -- enter contact details manually
              </button>
            </div>
          ) : selectedRequester ? (
            /* Selected requester summary */
            <div>
              <Label>Requester</Label>
              <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-gray-900">
                    {selectedRequester.name}
                  </span>
                  <span className="text-sm text-gray-500"> ({selectedRequester.email})</span>
                  {selectedRequester.organization_name && (
                    <Badge hue="blue" size="sm" className="ml-2">
                      {selectedRequester.organization_name}
                    </Badge>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="ml-2 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Recent Tickets Panel */}
              {loadingRecent ? (
                <div className="mt-3 flex items-center justify-center py-3 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading recent tickets...
                </div>
              ) : recentTickets.length > 0 ? (
                <div className="mt-3">
                  {/* Open ticket warning */}
                  {openTicketCount > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-md p-3 mb-2">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                        <p className="text-sm text-amber-800">
                          This customer has {openTicketCount} open ticket
                          {openTicketCount !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Recent Tickets
                    </h4>
                    <div className="space-y-2">
                      {recentTickets.map((ticket) => (
                        <a
                          key={ticket.id}
                          href={`/dashboard/support/${ticket.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-between text-sm hover:bg-gray-100 rounded px-2 py-1.5 -mx-1 group"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="text-gray-500 font-mono text-xs">
                              #{ticket.ticket_number}
                            </span>
                            <span className="ml-2 text-gray-900 truncate">
                              {ticket.subject}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                                STATUS_COLORS[ticket.status as keyof typeof STATUS_COLORS] ||
                                'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {ticket.status.replace('_', ' ')}
                            </span>
                            <span className="text-xs text-gray-400">
                              {new Date(ticket.created_at).toLocaleDateString()}
                            </span>
                            <ExternalLink className="h-3 w-3 text-gray-400 opacity-0 group-hover:opacity-100" />
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            /* Manual entry fields */
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Contact Details</Label>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="text-xs text-primary-600 hover:text-primary-800 underline"
                >
                  Back to search
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label required>Email</Label>
                  <input
                    type="email"
                    required
                    value={requesterEmail}
                    onChange={(e) => setRequesterEmail(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="customer@example.com"
                  />
                </div>
                <div>
                  <Label required>Name</Label>
                  <input
                    type="text"
                    required
                    value={requesterName}
                    onChange={(e) => setRequesterName(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="John Doe"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Phone Number */}
          <div>
            <Label>Phone Number</Label>
            <input
              type="tel"
              value={requesterPhone}
              onChange={(e) => setRequesterPhone(e.target.value)}
              className={INPUT_CLASS}
              placeholder="(555) 123-4567"
            />
          </div>

          {/* Preferred Contact Method */}
          <div>
            <Label>Preferred Contact Method</Label>
            <div className="flex gap-4 mt-1">
              {(['email', 'phone', 'either'] as PreferredContact[]).map((method) => (
                <label key={method} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="preferredContact"
                    value={method}
                    checked={preferredContact === method}
                    onChange={(e) => setPreferredContact(e.target.value as PreferredContact)}
                    className="text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-sm text-gray-700 capitalize">{method}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Subject */}
          <div>
            <Label required>Subject</Label>
            <input
              type="text"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={INPUT_CLASS}
              placeholder="Brief description of the issue"
            />
          </div>

          {/* Description */}
          <div>
            <Label required>Description</Label>
            <textarea
              required
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`${INPUT_CLASS} resize-none`}
              placeholder="Detailed description of the issue..."
            />
          </div>

          {/* Category + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Category</Label>
              <select
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setSubcategoryId('');
                }}
                className={INPUT_CLASS}
              >
                <option value="">Select category...</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label>
                Priority
                <span className="relative inline-block ml-1 group">
                  <Info className="inline h-3.5 w-3.5 text-gray-400 cursor-help" />
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-56 px-3 py-2 text-xs text-gray-700 bg-white border border-gray-200 rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-20">
                    <strong>Low:</strong> General questions, no urgency<br />
                    <strong>Normal:</strong> Standard issues, reasonable timeframe<br />
                    <strong>High:</strong> Business impact, needs prompt attention<br />
                    <strong>Urgent:</strong> Critical blocker, immediate action needed
                  </span>
                </span>
              </Label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TicketPriority)}
                className={INPUT_CLASS}
              >
                {(Object.entries(PRIORITY_LABELS) as [TicketPriority, string][]).map(
                  ([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>

          {/* Subcategory (conditional) */}
          {selectedCategory?.children && selectedCategory.children.length > 0 && (
            <div>
              <Label>Subcategory</Label>
              <select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Select subcategory...</option>
                {selectedCategory.children.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Compliance disclaimer */}
          {disclaimer && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
              <p className="text-sm text-amber-800">{disclaimer}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || (!selectedRequester && !manualEntry)}
            >
              {submitting ? 'Creating...' : 'Create Ticket'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
