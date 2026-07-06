'use client';

/**
 * Support Dashboard - Ticket Queue Page
 *
 * Main support page at /dashboard/support showing:
 * - Search bar (full-text search via tsvector)
 * - Stats cards (open, unassigned, urgent)
 * - Filter bar (status, priority, category, assignee)
 * - Ticket table with sortable columns and pagination
 * - Create ticket button
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Plus } from 'lucide-react';
import { PageHeader, Button } from '@keepr/design-system';
import { listTickets } from '@/lib/support-queries';
import type { SupportTicket } from '@/lib/support-types';
import { StatsCards } from './components/StatsCards';
import { TicketFilters } from './components/TicketFilters';
import { CreateTicketDialog } from './components/CreateTicketDialog';
import { BulkActionBar } from './components/BulkActionBar';
import { ColumnSelector } from './components/ColumnSelector';
import { SavedViewSelector } from './components/SavedViewSelector';
import { SearchBar } from './components/SearchBar';
import { useTicketTableState } from './hooks/useTicketTableState';

const TicketTable = dynamic(() => import('./components/TicketTable').then(m => m.TicketTable), { ssr: false });

export default function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Page-specific: assignee filter (Queue page has assignee filter, My Tickets doesn't)
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  const {
    sortColumn, sortDirection, handleSort,
    selectedIds, toggleSelect, toggleSelectAll, clearSelection,
    visibleColumns, handleColumnsChange,
    statusFilter, priorityFilter, categoryFilter, searchQuery,
    handleStatusChange, handlePriorityChange, handleCategoryChange, handleSearch,
    currentFilters: baseCurrentFilters, handleLoadView: baseHandleLoadView,
    page, setPage,
  } = useTicketTableState(tickets);

  const pageSize = 20;

  // Ref to allow handleBulkComplete to call loadTickets without circular deps
  const loadTicketsRef = useRef<() => void>(() => {});

  const handleBulkComplete = useCallback(() => {
    clearSelection();
    loadTicketsRef.current();
  }, [clearSelection]);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTickets({
        status: statusFilter,
        priority: priorityFilter,
        category_id: categoryFilter,
        assignee_id: assigneeFilter,
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
      console.error('Failed to load tickets:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, priorityFilter, categoryFilter, assigneeFilter, searchQuery, page, sortColumn, sortDirection]);

  loadTicketsRef.current = loadTickets;

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  // Clear selection when assignee filter changes (hook handles the rest)
  useEffect(() => {
    clearSelection();
  }, [assigneeFilter, clearSelection]);

  function handleAssigneeChange(assigneeId: string | null) {
    setAssigneeFilter(assigneeId);
    setPage(1);
  }

  // Extend base saved-view filters with assignee_id
  const currentFilters = useMemo(() => ({
    ...baseCurrentFilters,
    assignee_id: assigneeFilter,
  }), [baseCurrentFilters, assigneeFilter]);

  const handleLoadView = useCallback((filters: Record<string, unknown>) => {
    baseHandleLoadView(filters);
    setAssigneeFilter((filters.assignee_id as string | null) ?? null);
  }, [baseHandleLoadView]);

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="Support"
        subtitle="Manage support tickets"
        actions={
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4" />
            Create Ticket
          </Button>
        }
      />

      {/* Stats Cards */}
      <StatsCards />

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
          assigneeId={assigneeFilter}
          onStatusChange={handleStatusChange}
          onPriorityChange={handlePriorityChange}
          onCategoryChange={handleCategoryChange}
          onAssigneeChange={handleAssigneeChange}
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
        onTicketUpdated={loadTickets}
      />

      {/* Bulk Action Bar */}
      <BulkActionBar
        selectedIds={selectedIds}
        onClearSelection={clearSelection}
        onComplete={handleBulkComplete}
      />

      {/* Create Ticket Dialog */}
      <CreateTicketDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreated={loadTickets}
      />
    </div>
  );
}
