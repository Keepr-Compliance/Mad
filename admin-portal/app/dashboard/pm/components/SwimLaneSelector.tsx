'use client';

/**
 * Toggle button group for selecting swim lane grouping mode on the board.
 * Options: No Grouping | Project | Area | Assignee
 */

export type SwimLaneMode = 'off' | 'project' | 'area' | 'assignee';

interface SwimLaneSelectorProps {
  value: SwimLaneMode;
  onChange: (mode: SwimLaneMode) => void;
}

const OPTIONS: { value: SwimLaneMode; label: string }[] = [
  { value: 'off', label: 'No Grouping' },
  { value: 'project', label: 'Project' },
  { value: 'area', label: 'Area' },
  { value: 'assignee', label: 'Assignee' },
];

export function SwimLaneSelector({ value, onChange }: SwimLaneSelectorProps) {
  return (
    <div className="inline-flex items-center rounded-lg border border-gray-200 bg-white p-0.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            value === opt.value
              ? 'bg-primary-100 text-primary-700'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
