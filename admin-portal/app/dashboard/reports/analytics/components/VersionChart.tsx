'use client';

/**
 * Version bar chart — Analytics report (BACKLOG-3723)
 *
 * The recharts block from VersionDistribution, lifted unchanged into its own
 * module so the report renders in a plain Node test without recharts.
 */

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { VersionDistribution as VersionDistributionData } from '@/lib/reports/analytics';

interface Props {
  data: VersionDistributionData[];
  expandedVersion: string | null;
  onBarClick: (entry: VersionDistributionData) => void;
}

const COLORS = [
  '#0ea5e9', // primary-500
  '#0284c7', // primary-600
  '#0369a1', // primary-700
  '#075985', // primary-800
  '#38bdf8', // primary-400
  '#7dd3fc', // primary-300
];

export function VersionChart({ data, expandedVersion, onBarClick }: Props) {
  return (
    <div className="h-64 mb-6">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="app_version"
            tick={{ fontSize: 12, fill: '#6b7280' }}
          />
          <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '13px',
            }}
            formatter={(value) => [Number(value) || 0, 'Users']}
          />
          <Bar
            dataKey="user_count"
            radius={[4, 4, 0, 0]}
            cursor="pointer"
            onClick={(_data, index) => {
              if (typeof index === 'number') onBarClick(data[index]);
            }}
          >
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={expandedVersion === entry.app_version
                  ? '#1d4ed8'
                  : COLORS[index % COLORS.length]}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
