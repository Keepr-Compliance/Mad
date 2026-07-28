import React, { useRef, useEffect } from "react";

interface SettingsTab {
  id: string;
  label: string;
}

interface SettingsTabBarProps {
  tabs: SettingsTab[];
  activeTabId: string;
  onTabClick: (id: string) => void;
}

export function SettingsTabBar({ tabs, activeTabId, onTabClick }: SettingsTabBarProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // BACKLOG-2160 / BACKLOG-1450: keep the active tab scrolled into view.
  // `inline: 'nearest'` performs the minimal horizontal scroll so the active tab
  // is never clipped off either edge, and is a no-op when it is already visible
  // (e.g. "General" at the left on open). `block: 'nearest'` avoids any vertical
  // page scroll, preserving the sticky-on-scroll + scroll-spy behavior.
  // No didMount guard → StrictMode-safe (the call is idempotent).
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  return (
    <div className="sticky top-0 z-10 bg-white border-b border-gray-200 -mx-6 px-6 overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
      {/* BACKLOG-2160 / BACKLOG-1450: left-align the tab strip. `justify-center`
          clips and makes the leftmost tabs unreachable by horizontal scroll when
          the tabs overflow, hiding "General" on open. */}
      <div className="flex gap-1" role="tablist" data-testid="settings-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={activeTabId === tab.id ? activeRef : undefined}
            role="tab"
            aria-selected={activeTabId === tab.id}
            data-testid={`settings-tab-${tab.id.replace(/^settings-/, "")}`}
            onClick={() => onTabClick(tab.id)}
            className={`px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
              activeTabId === tab.id
                ? "text-blue-600 border-blue-600"
                : "text-gray-500 border-transparent hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
