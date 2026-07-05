/**
 * Empty State Component
 *
 * Professional empty states with icons and optional actions.
 * Delegates to the @keepr/design-system EmptyState (chrome-less variant —
 * broker call sites render these inside existing cards/tables).
 */

import { ReactNode } from 'react';
import { EmptyState as DSEmptyState, cn } from '@keepr/design-system';
import { Inbox, Search, FileText, MessagesSquare, Paperclip } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * Generic Empty State
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <DSEmptyState
      card={false}
      title={title}
      description={description}
      icon={icon ? <div className="flex justify-center text-gray-300">{icon}</div> : undefined}
      action={action}
      className={className}
    />
  );
}

/**
 * Inbox/Document Icon for empty states
 */
export function InboxIcon({ className }: { className?: string }) {
  return <Inbox className={cn('w-12 h-12 text-gray-300', className)} />;
}

/**
 * Search/Filter Icon
 */
export function SearchIcon({ className }: { className?: string }) {
  return <Search className={cn('w-12 h-12 text-gray-300', className)} />;
}

/**
 * Document Icon
 */
export function DocumentIcon({ className }: { className?: string }) {
  return <FileText className={cn('w-12 h-12 text-gray-300', className)} />;
}

/**
 * Messages Icon
 */
export function MessagesIcon({ className }: { className?: string }) {
  return <MessagesSquare className={cn('w-12 h-12 text-gray-300', className)} />;
}

/**
 * Attachment/Paperclip Icon
 */
export function AttachmentIcon({ className }: { className?: string }) {
  return <Paperclip className={cn('w-12 h-12 text-gray-300', className)} />;
}

/**
 * Empty Submissions State
 */
export function EmptySubmissions({ filtered = false }: { filtered?: boolean }) {
  if (filtered) {
    return (
      <EmptyState
        icon={<SearchIcon />}
        title="No matching submissions"
        description="Try adjusting your filters or search criteria to find what you're looking for."
      />
    );
  }

  return (
    <EmptyState
      icon={<InboxIcon />}
      title="No submissions yet"
      description="When agents submit transactions for review, they'll appear here. You'll be notified of new submissions in real-time."
    />
  );
}

/**
 * Empty Messages State
 */
export function EmptyMessages() {
  return (
    <EmptyState
      icon={<MessagesIcon />}
      title="No messages"
      description="This submission doesn't have any attached messages."
    />
  );
}

/**
 * Empty Attachments State
 */
export function EmptyAttachments() {
  return (
    <EmptyState
      icon={<AttachmentIcon />}
      title="No attachments"
      description="This submission doesn't have any attached files."
    />
  );
}
