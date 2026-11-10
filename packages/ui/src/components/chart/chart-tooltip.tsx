export interface ChartTooltipState {
  x: number;
  y: number;
  lines: string[];
}

/**
 * A fixed box that follows the pointer. First line bold. Renders nothing until
 * a column is hovered, so a static render carries no tooltip.
 */
export function ChartTooltip({ tooltip }: { tooltip: ChartTooltipState | null }) {
  if (!tooltip) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
      style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
    >
      {tooltip.lines.map((line, i) => (
        <div key={i} className={i === 0 ? 'font-semibold' : 'text-gray-200'}>
          {line}
        </div>
      ))}
    </div>
  );
}
