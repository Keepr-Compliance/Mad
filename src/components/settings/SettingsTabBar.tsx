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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll the tab bar horizontally to show the active tab
  useEffect(() => {
    const container = scrollContainerRef.current;
    const activeBtn = activeRef.current;
    if (!container || !activeBtn) return;

    // Calculate scroll position to center the active tab
    const containerRect = container.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    const scrollLeft = container.scrollLeft + (btnRect.left - containerRect.left) - (containerRect.width / 2) + (btnRect.width / 2);
    container.scrollTo?.({ left: scrollLeft, behavior: "smooth" });
  }, [activeTabId]);

  return (
    <div ref={scrollContainerRef} className="sticky top-0 z-10 bg-white border-b border-gray-200 -mx-6 px-6 overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
      <div className="flex gap-1 sm:justify-center" role="tablist" data-testid="settings-tabs">
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
