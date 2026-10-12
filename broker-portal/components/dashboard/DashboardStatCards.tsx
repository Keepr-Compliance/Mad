'use client';

/**
 * The dashboard's four stat cards — BACKLOG-3904.
 *
 * Below md: a 2x2 grid of compact one-row cards (icon, label one word per line, value right-aligned). From md
 * up the layout is the one the page always had (`StatCard` from the design
 * system: 2 columns, 4 from lg, gap-4, p-5, icon beside the text).
 *
 * A card with an href is one real link. A card without one stays a plain box.
 */

import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { startNavigationProgress } from '@/components/pwa/NavigationProgress';
import type { StatCardData, StatCardKey } from '@/lib/dashboard/statCards';

type Hue = 'blue' | 'green' | 'gray' | 'orange';

const TILE: Record<Hue, string> = {
  blue: 'text-blue-600 bg-blue-50',
  green: 'text-green-600 bg-green-50',
  gray: 'text-gray-600 bg-gray-50',
  orange: 'text-orange-600 bg-orange-50',
};

const HUE: Record<StatCardKey, Hue> = {
  pending: 'blue',
  needs_changes: 'orange',
  approved: 'green',
  total: 'gray',
};

const BOX =
  'bg-white rounded-lg border border-gray-200 p-5 flex items-center gap-4 max-md:gap-2 max-md:px-2.5 max-md:py-3.5';

const LINK_AFFORDANCE =
  'min-h-[44px] cursor-pointer transition-colors [@media(hover:hover)]:hover:border-gray-300 [@media(hover:hover)]:hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2';

function Body({ card, icon }: { card: StatCardData; icon: ReactNode }) {
  return (
    <>
      <div className={`rounded-lg p-3 max-md:p-2 ${TILE[HUE[card.key]]}`}>{icon}</div>
      <div className="min-w-0 max-md:contents">
        <p
          data-stat-label
          className="text-sm font-medium text-gray-500 truncate max-md:text-xs max-md:leading-tight max-md:whitespace-normal max-md:min-w-0 max-md:flex-1"
        >
          {card.label.split(' ').map((word, i) => (
            <Fragment key={word}>
              {i > 0 ? ' ' : null}
              <span className="max-md:block">{word}</span>
            </Fragment>
          ))}
        </p>
        <div className="flex items-baseline gap-2 max-md:ml-auto">
          <p data-stat-value className="text-2xl font-semibold text-gray-900">{card.value}</p>
        </div>
      </div>
    </>
  );
}

export function DashboardStatCards({ cards, icons }: { cards: StatCardData[]; icons: Record<StatCardKey, ReactNode> }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
      {cards.map((card) =>
        card.href ? (
          <Link
            key={card.key}
            href={card.href}
            aria-label={`${card.label}: ${card.value}, view submissions`}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0) return;
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              startNavigationProgress();
            }}
            className={`${BOX} ${LINK_AFFORDANCE}`}
          >
            <Body card={card} icon={icons[card.key]} />
          </Link>
        ) : (
          <div key={card.key} className={BOX}>
            <Body card={card} icon={icons[card.key]} />
          </div>
        )
      )}
    </div>
  );
}
