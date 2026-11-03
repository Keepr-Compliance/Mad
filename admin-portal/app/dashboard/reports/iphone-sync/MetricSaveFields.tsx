'use client';

/**
 * The card's Column and Function selects, rendered inside the kit SavedViews
 * save form through its `saveFields` slot (BACKLOG-4084). Used by iPhone Sync
 * and Exports, each with its own columns.
 *
 * Controlled: the report holds the chosen metric, because the kit's `onSave`
 * carries only the name.
 */

export interface MetricOption {
  value: string;
  label: string;
}

export interface MetricChoice {
  col: string;
  fn: string;
}

const FIELD_CLASS =
  'text-sm border border-gray-300 rounded px-2 py-1 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500';

export interface MetricSaveFieldsProps {
  value: MetricChoice;
  onChange: (next: MetricChoice) => void;
  columns: MetricOption[];
  functions: MetricOption[];
  functionsForColumn: (col: string) => string[];
}

export function MetricSaveFields({
  value,
  onChange,
  columns,
  functions,
  functionsForColumn,
}: MetricSaveFieldsProps) {
  const allowed = functionsForColumn(value.col);

  function chooseColumn(col: string) {
    // `runs` offers count only, so a stale "average" would be unreachable.
    const next = functionsForColumn(col);
    onChange({ col, fn: next.includes(value.fn) ? value.fn : next[0] });
  }

  return (
    <div className="flex gap-2">
      <select
        aria-label="Column"
        value={value.col}
        onChange={(e) => chooseColumn(e.target.value)}
        className={`${FIELD_CLASS} flex-1`}
      >
        {columns.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Function"
        value={value.fn}
        onChange={(e) => onChange({ col: value.col, fn: e.target.value })}
        className={`${FIELD_CLASS} flex-1`}
      >
        {functions
          .filter((f) => allowed.includes(f.value))
          .map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
      </select>
    </div>
  );
}
