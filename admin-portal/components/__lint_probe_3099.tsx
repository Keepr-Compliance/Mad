'use client';

// BACKLOG-3099 control 1b/3: deliberate ERROR-severity lint violation in
// admin-portal (react-hooks/rules-of-hooks — a hook called conditionally).
// Removed before merge. Not imported anywhere.
import { useState } from 'react';

export function LintProbe3099({ enabled }: { enabled: boolean }) {
  if (enabled) {
    const [n] = useState(0);
    return <span>{n}</span>;
  }
  return null;
}
