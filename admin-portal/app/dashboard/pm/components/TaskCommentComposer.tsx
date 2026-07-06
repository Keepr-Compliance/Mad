'use client';

/**
 * TaskCommentComposer - PM Item Detail
 *
 * Simple textarea + submit button for adding comments to a backlog item.
 * Adapted from support ReplyComposer but heavily simplified:
 * no reply/note toggle, no file upload, no templates.
 */

import { useState, useCallback } from 'react';
import { Send } from 'lucide-react';
import { addComment } from '@/lib/pm-queries';

interface TaskCommentComposerProps {
  itemId: string;
  onCommentAdded: () => void;
}

export function TaskCommentComposer({ itemId, onCommentAdded }: TaskCommentComposerProps) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await addComment(itemId, null, body.trim());
      setBody('');
      onCommentAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment');
    } finally {
      setSubmitting(false);
    }
  }, [body, itemId, onCommentAdded]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="p-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment..."
          rows={3}
          className="w-full border-0 resize-none text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-0"
        />

        {error && <div className="mb-2 text-sm text-red-600">{error}</div>}

        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Ctrl+Enter to send</span>
          <button
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-3.5 w-3.5" />
            {submitting ? 'Sending...' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}
