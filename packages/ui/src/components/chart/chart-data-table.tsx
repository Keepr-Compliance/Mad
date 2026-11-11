import type { ChartDatum, ChartSeries } from './types';

export interface ChartDataTableProps {
  caption: string;
  data: ChartDatum[];
  series: ChartSeries[];
  formatValue: (value: number, series: ChartSeries) => string;
  /** Header of the category column. */
  categoryHeader?: string;
}

/** Text a screen reader hears for a null value. */
export const NO_DATA_TEXT = 'No data';

/**
 * The chart's numbers as a table, for screen readers only (`sr-only`). One row
 * per category, one column per series.
 */
export function ChartDataTable({
  caption,
  data,
  series,
  formatValue,
  categoryHeader = 'Category',
}: ChartDataTableProps) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{categoryHeader}</th>
          {series.map((s) => (
            <th key={s.key} scope="col">
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <th scope="row">{d.label}</th>
            {series.map((s) => {
              const v = d.values[s.key];
              return <td key={s.key}>{v === null || v === undefined ? NO_DATA_TEXT : formatValue(v, s)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
