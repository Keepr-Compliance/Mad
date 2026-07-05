import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes, HTMLAttributes } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../cn';

export interface TableContainerProps {
  children: ReactNode;
  className?: string;
  /** Use horizontal scrolling instead of clipping for wide tables. */
  scrollX?: boolean;
}

/** Card-style wrapper around a table. */
export function TableContainer({ children, className, scrollX = false }: TableContainerProps) {
  return (
    <div
      className={cn(
        'bg-white rounded-lg shadow-sm border border-gray-200',
        scrollX ? 'overflow-x-auto' : 'overflow-hidden',
        className
      )}
    >
      {children}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cn('min-w-full divide-y divide-gray-200', className)}>{children}</table>;
}

export function TableHead({ children, className }: { children: ReactNode; className?: string }) {
  return <thead className={cn('bg-gray-50', className)}>{children}</thead>;
}

export function TableBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn('bg-white divide-y divide-gray-200', className)}>{children}</tbody>;
}

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  children: ReactNode;
  /** Adds hover + pointer affordances for clickable rows. */
  clickable?: boolean;
}

export function Tr({ children, clickable, className, ...rest }: TrProps) {
  return (
    <tr className={cn(clickable && 'hover:bg-gray-50 cursor-pointer transition-colors', className)} {...rest}>
      {children}
    </tr>
  );
}

export function Th({ children, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn('px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider', className)}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /** 'primary' renders the darker emphasized cell text. */
  emphasis?: 'primary' | 'secondary';
}

export function Td({ children, className, emphasis = 'secondary', ...rest }: TdProps) {
  return (
    <td
      className={cn(
        'px-6 py-4 whitespace-nowrap text-sm',
        emphasis === 'primary' ? 'font-medium text-gray-900' : 'text-gray-500',
        className
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/** Full-width empty row for "no results" states inside a table. */
export function TableEmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-6 py-12 text-center">
        <p className="text-sm text-gray-500">{children}</p>
      </td>
    </tr>
  );
}

export interface PaginationBarProps {
  children: ReactNode;
  className?: string;
  /** 'top' renders the bar above the table (border-b instead of border-t). */
  position?: 'top' | 'bottom';
}

export function PaginationBar({ children, className, position = 'bottom' }: PaginationBarProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-3 bg-gray-50 border-gray-200',
        position === 'bottom' ? 'border-t' : 'border-b',
        className
      )}
    >
      {children}
    </div>
  );
}

export const paginationButtonClasses =
  'inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed';

export interface PaginationButtonProps extends HTMLAttributes<HTMLButtonElement> {
  direction: 'prev' | 'next';
  disabled?: boolean;
  children?: ReactNode;
}

export function PaginationButton({ direction, disabled, children, className, ...rest }: PaginationButtonProps) {
  return (
    <button type="button" disabled={disabled} className={cn(paginationButtonClasses, className)} {...rest}>
      {direction === 'prev' && <ChevronLeft className="h-4 w-4 mr-1" />}
      {children ?? (direction === 'prev' ? 'Previous' : 'Next')}
      {direction === 'next' && <ChevronRight className="h-4 w-4 ml-1" />}
    </button>
  );
}
