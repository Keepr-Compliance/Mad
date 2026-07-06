'use client';

/**
 * SentryErrorsCard - Client component that fetches and displays Sentry errors
 *
 * Fetches from /api/sentry/user-issues to avoid exposing the Sentry token.
 * Gracefully degrades if Sentry is not configured or the API fails.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { Card } from '@keepr/design-system';
import { formatTimestamp } from '@/lib/format';

const INITIAL_COUNT = 5;

interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: string;
  lastSeen: string;
  permalink: string;
}

function getLevelColor(level: string): string {
  switch (level) {
    case 'fatal':
      return 'bg-red-100 text-red-800';
    case 'error':
      return 'bg-danger-50 text-danger-600';
    case 'warning':
      return 'bg-warning-50 text-warning-600';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

export function SentryErrorsCard({ email }: { email: string }) {
  const [issues, setIssues] = useState<SentryIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    async function fetchIssues() {
      try {
        const res = await fetch(
          `/api/sentry/user-issues?email=${encodeURIComponent(email)}`
        );
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            setError('Not authorized');
            return;
          }
          setError('Failed to load Sentry data');
          return;
        }
        const data = await res.json();
        setIssues(data.issues ?? []);
      } catch {
        setError('Failed to connect to Sentry');
      } finally {
        setLoading(false);
      }
    }

    fetchIssues();
  }, [email]);

  return (
    <Card>
      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-gray-400" />
        Sentry Errors
      </h3>

      {loading && (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-primary-600" />
          Loading Sentry data...
        </div>
      )}

      {error && (
        <p className="mt-4 text-sm text-gray-400">{error}</p>
      )}

      {!loading && !error && issues.length === 0 && (
        <p className="mt-4 text-sm text-gray-500">
          No Sentry issues found for this user.
        </p>
      )}

      {!loading && !error && issues.length > 0 && (
        <>
          <ul className="mt-4 space-y-2">
            {(expanded ? issues : issues.slice(0, INITIAL_COUNT)).map((issue) => (
              <li
                key={issue.id}
                className="p-3 rounded-md bg-gray-50 hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <a
                      href={issue.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-gray-900 hover:text-primary-600 truncate block"
                    >
                      {issue.title}
                    </a>
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {issue.culprit}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getLevelColor(issue.level)}`}
                    >
                      {issue.level}
                    </span>
                    <span className="text-xs text-gray-400">
                      {issue.count}x
                    </span>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Last seen {formatTimestamp(issue.lastSeen)}
                </p>
              </li>
            ))}
          </ul>
          {issues.length > INITIAL_COUNT && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-3 flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 font-medium transition-colors"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-4 w-4" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4" />
                  Show all {issues.length} errors
                </>
              )}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
