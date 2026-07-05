import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { Search } from 'lucide-react';
import { cn } from '../cn';

/** Shared control styling for Input/Select/Textarea. */
export const inputClasses =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
  /** Renders a red asterisk after the label text. */
  required?: boolean;
}

export function Label({ children, required, className, ...rest }: LabelProps) {
  return (
    <label className={cn('block text-sm font-medium text-gray-700 mb-1', className)} {...rest}>
      {children}
      {required && <span className="text-red-500"> *</span>}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClasses, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputClasses, className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClasses, 'resize-none', className)} {...rest} />;
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn('h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500', className)}
      {...rest}
    />
  );
}

export function FieldError({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mt-1 text-sm text-red-600', className)}>{children}</p>;
}

export function FieldHelp({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mt-1 text-xs text-gray-400', className)}>{children}</p>;
}

export interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Optional right-aligned adornment (clear button, spinner). */
  trailing?: ReactNode;
  containerClassName?: string;
}

/** Search field with the leading magnifier icon. */
export function SearchInput({ trailing, className, containerClassName, ...rest }: SearchInputProps) {
  return (
    <div className={cn('relative', containerClassName)}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
      <input
        type="search"
        className={cn(
          'w-full pl-10 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
          trailing ? 'pr-10' : 'pr-4',
          className
        )}
        {...rest}
      />
      {trailing && <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center">{trailing}</div>}
    </div>
  );
}
