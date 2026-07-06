import { Loader2 } from 'lucide-react';
import { cn } from '../cn';

export type SpinnerSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
};

/** lucide Loader2 spinner. Default color matches page-level loading (gray-300). */
export function Spinner({ size = 'lg', className }: { size?: SpinnerSize; className?: string }) {
  return <Loader2 className={cn('animate-spin text-gray-300', SIZE_CLASSES[size], className)} />;
}

/** Full-area centered spinner for page/section loading states. */
export function LoadingState({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center py-12', className)}>
      <Spinner size="lg" />
    </div>
  );
}
