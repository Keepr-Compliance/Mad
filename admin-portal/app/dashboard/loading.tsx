/**
 * Dashboard route loading state (BACKLOG-3797). Shown inside the dashboard
 * layout's <main> while a server component loads. Static: no data fetching.
 */
export default function DashboardLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" data-testid="dashboard-loading" className="animate-pulse space-y-4">
      <div className="h-7 w-48 rounded bg-gray-200" />
      <div className="h-4 w-72 max-w-full rounded bg-gray-200" />
      <div className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 w-full rounded bg-gray-100" />
        ))}
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
