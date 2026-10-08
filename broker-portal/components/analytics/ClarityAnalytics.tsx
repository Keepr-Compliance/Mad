'use client';

import { useEffect } from 'react';

export default function ClarityAnalytics({ projectId }: { projectId: string }) {
  useEffect(() => {
    // Dynamic import to avoid SSR issues
    import('@microsoft/clarity').then((module) => {
      module.default.init(projectId);
    });
  }, [projectId]);

  return null;
}
