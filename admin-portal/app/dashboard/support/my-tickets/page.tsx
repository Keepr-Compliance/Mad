'use client';

/**
 * My Tickets Page - Support Dashboard
 *
 * Shows tickets assigned to the currently logged-in agent.
 * Reuses the same TicketTable, TicketFilters, and SearchBar components as the Queue page,
 * but pre-filters all queries by the current user's assignee_id.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Inbox, CheckCircle2, Clock } from 'lucide-react';
import { PageHeader, StatCard } from '@keepr/design-system';
import { useAuth } from '@/components/providers/AuthProvider';
import { listTickets } from '@/lib/support-queries';
import type { SupportTicket } from '@/lib/support-types';
import { TicketFilters } from '../components/TicketFilters';
import { SearchBar } from '../components/SearchBar';
import { BulkActionBar } from '../components/BulkActionBar';
import { ColumnSelector } from '../components/ColumnSelector';
import { SavedViewSelector } from '../components/SavedViewSelector';
import { useTicketTableState } from '../hooks/useTicketTableState';

const TicketTable = dynamic(() => import('../components/TicketTable').then(m => m.TicketTable), { ssr: false });

export default function MyTicketsPage() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  // Agent-specific stats
  const [myOpen, setMyOpen] = useState(0);
  const [myPending, setMyPending] = useState(0);
  const [myResolved, setMyResolved] = useState(0);
  const [statsLoading, setStatsLoading] = useState(true);

  const {
    sortColumn, sortDirection, handleSort,
    selectedIds, toggleSelect, toggleSelectAll, clearSelection,
    visibleColumns, handleColumnsChange,
    statusFilter, priorityFilter, categoryFilter, searchQuery,
    handleStatusChange, handlePriorityChange, handleCategoryChange, handleSearch,
    currentFilters, handleLoadView,
    page, setPage,
  } = useTicketTableState(tickets);

  const pageSize = 20;

  // Refs to allow handleBulkComplete to call functions without circular deps
  const loadTicketsRef = useRef<() => void>(() => {});
  const loadMyStatsRef = useRef<() => void>(() => {});

  const handleBulkComplete = useCallback(() => {
    clearSelection();
    loadTicketsRef.current();
    loadMyStatsRef.current();
  }, [clearSelection]);

  const handleTicketUpdated = useCallback(() => {
    loadTicketsRef.current();
    loadMyStatsRef.current();
  }, []);

  const loadTickets = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const data = await listTickets({
        assignee_id: user.id,
        status: statusFilter,
        priority: priorityFilter,
        category_id: categoryFilter,
        search: searchQuery || undefined,
        page,
        page_size: pageSize,
        sort_by: sortColumn,
        sort_dir: sortDirection,
      });
      setTickets(data.tickets);
      setTotalCount(data.total_count);
      setTotalPages(data.total_pages);
    } catch (err) {
      console.error('Failed to load my tickets:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id, statusFilter, priorityFilter, categoryFilter, searchQuery, page, sortColumn, sortDirection]);

  const loadMyStats = useCallback(async () => {
    if (!user?.id) return;
    setStatsLoading(true);
    try {
      const [openData, pendingData, resolvedData] = await Promise.all([
        listTickets({ assignee_id: user.id, status: 'in_progress', page: 1, page_size: 1 }),
        listTickets({ assignee_id: user.id, status: 'pending', page: 1, page_size: 1 }),
        listTickets({ assignee_id: user.id, status: 'resolved', page: 1, page_size: 1 }),
      ]);
      setMyOpen(openData.total_count);
      setMyPending(pendingData.total_count);
      setMyResolved(resolvedData.total_count);
    } catch (err) {
      console.error('Failed to load my stats:', err);
    } finally {
      setStatsLoading(false);
    }
  }, [user?.id]);

  loadTicketsRef.current = loadTickets;
  loadMyStatsRef.current = loadMyStats;

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    loadMyStats();
  }, [loadMyStats]);

  const statCards = [
    { label: 'My In Progress', value: myOpen, icon: Inbox, hue: 'blue' as const },
    { label: 'My Pending', value: myPending, icon: Clock, hue: 'yellow' as const },
    { label: 'My Resolved', value: myResolved, icon: CheckCircle2, hue: 'green' as const },
  ];

  return (
    <div>
      {/* Header */}
      <PageHeader title="My Tickets" subtitle="Tickets assigned to you" />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-6">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <StatCard
              key={card.label}
              label={card.label}
              value={statsLoading ? '-' : card.value}
              icon={<Icon className="h-5 w-5" />}
              hue={card.hue}
            />
          );
        })}
      </div>

      {/* Search Bar */}
      <div className="mb-4">
        <SearchBar onSearch={handleSearch} />
      </div>

      {/* Filters + Column Selector */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <TicketFilters
          status={statusFilter}
          priority={priorityFilter}
          categoryId={categoryFilter}
          onStatusChange={handleStatusChange}
          onPriorityChange={handlePriorityChange}
          onCategoryChange={handleCategoryChange}
        />
        <div className="flex items-center gap-2">
          <SavedViewSelector
            currentFilters={currentFilters}
            onLoadView={handleLoadView}
          />
          <ColumnSelector
            visibleColumns={visibleColumns}
            onColumnsChange={handleColumnsChange}
          />
        </div>
      </div>

      {/* Ticket Table */}
      <TicketTable
        tickets={tickets}
        totalCount={totalCount}
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        onPageChange={setPage}
        loading={loading}
        searchActive={!!searchQuery}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        visibleColumns={visibleColumns}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
        onTicketUpdated={handleTicketUpdated}
      />

      {/* Bulk Action Bar */}
      <BulkActionBar
        selectedIds={selectedIds}
        onClearSelection={clearSelection}
        onComplete={handleBulkComplete}
      />
    </div>
  );
}
