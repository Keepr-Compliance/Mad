/**
 * The three "How Keepr is doing" tiles (boards L1 and L4) — BACKLOG-4120 PR3.
 * Counts only.
 */
import React from "react";
import { cn } from "@keepr/ui";
import type { LearnTiles } from "./learnScoreView";

export function LearnStatTiles({ tiles, className }: { tiles: LearnTiles; className?: string }): React.ReactElement {
  const cells: Array<{ value: string; label: string; tone: string; testId: string }> = [
    tiles.empty
      ? { value: "Not enough deals yet to score", label: "", tone: "text-gray-600", testId: "learn-tile-found" }
      : { value: `${tiles.found} of ${tiles.of}`, label: "of your deals found", tone: "text-green-700", testId: "learn-tile-found" },
    { value: String(tiles.wrongFinds), label: "wrong finds", tone: "text-amber-700", testId: "learn-tile-wrong" },
    { value: tiles.empty ? "-" : String(tiles.missed), label: "deals missed", tone: "text-red-700", testId: "learn-tile-missed" },
  ];
  return (
    <div className={cn("grid grid-cols-3", className)}>
      {cells.map((c, i) => (
        <div
          key={c.testId}
          data-testid={c.testId}
          className={cn("flex flex-col gap-0.5 px-5 py-4 text-left", i < cells.length - 1 && "border-r border-[#EEECE7]")}
        >
          <span className={cn("text-[22px] font-semibold leading-tight", c.tone)}>{c.value}</span>
          <span className="text-[13px] text-gray-500">{c.label}</span>
        </div>
      ))}
    </div>
  );
}
