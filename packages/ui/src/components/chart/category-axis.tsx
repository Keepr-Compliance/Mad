import { barLayout, CHART_HEIGHT, thinLabels } from './scale';
import { CHART_AXIS_TEXT_COLOR } from './palette';

export interface CategoryAxisProps {
  categories: Array<{ key: string; label: string }>;
}

/** Category labels under the plot, thinned past 14 so they never overlap. */
export function CategoryAxis({ categories }: CategoryAxisProps) {
  const slots = barLayout(categories.length);
  const show = thinLabels(categories.length);
  return (
    <g aria-hidden="true">
      {categories.map((c, i) =>
        show[i] ? (
          <text
            key={c.key}
            x={slots[i].slotCentre}
            y={CHART_HEIGHT - 8}
            textAnchor="middle"
            fontSize={10}
            fill={CHART_AXIS_TEXT_COLOR}
          >
            {c.label}
          </text>
        ) : null
      )}
    </g>
  );
}
