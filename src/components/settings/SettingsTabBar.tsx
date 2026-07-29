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
  const stripRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // BACKLOG-2160 / BACKLOG-1450: keep the active tab scrolled into view within
  // the horizontal tab strip, so it's never clipped off either edge. This is a
  // no-op when the tab is already fully visible (e.g. "General" at the left on
  // open).
  //
  // BACKLOG-2322: this USED to call
  // `activeRef.current.scrollIntoView({ block: "nearest", inline: "nearest" })`,
  // but `Element.scrollIntoView()` scrolls EVERY scrollable ancestor to bring
  // the target into view, not just this strip. This strip is `sticky top-0`
  // inside the Settings modal's vertical scroll container
  // (`Settings.tsx`'s `overflow-y-auto` div), and that SAME container drives
  // `useScrollSpy()` -> `activeTabId`. So scrolling down flips `activeTabId`,
  // which fires this effect, which called `scrollIntoView` on the newly-active
  // tab — and because the tab sits inside a sticky ancestor, Chromium's
  // block-axis "nearest" calculation scrolled the VERTICAL container back to
  // the top, trapping the user and making it impossible to scroll past the
  // tab strip. `block: "nearest"` is NOT a vertical no-op when the target is
  // inside a sticky ancestor.
  //
  // Fix: scroll ONLY the strip's own `scrollLeft`, computed manually from
  // bounding rects, so this effect can never reach outside the horizontal
  // strip to touch a vertical ancestor's scroll position.
  //
  // No didMount guard → StrictMode-safe: once the active tab is within the
  // strip's visible horizontal range, re-running this is a no-op.
  useEffect(() => {
    const strip = stripRef.current;
    const active = activeRef.current;
    if (!strip || !active) return;

    const stripRect = strip.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    if (activeRect.left < stripRect.left) {
      strip.scrollLeft -= stripRect.left - activeRect.left;
    } else if (activeRect.right > stripRect.right) {
      strip.scrollLeft += activeRect.right - stripRect.right;
    }
    // else: the active tab is already fully within the strip's visible
    // horizontal range — no-op.
  }, [activeTabId]);

  return (
    <div
      ref={stripRef}
      data-testid="settings-tab-strip"
      className="sticky top-0 z-10 bg-white border-b border-gray-200 -mx-6 px-6 overflow-x-auto scrollbar-hide"
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
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
