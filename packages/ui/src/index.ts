/**
 * @keepr/ui — shared component library (shadcn/ui-style source on Radix
 * primitives, themed by @keepr/design-system tokens).
 *
 * These are IMPORTED components (the shared-package model), not copy-in
 * snippets: consume via `import { Button } from '@keepr/ui'`. See README.md.
 */

export { cn } from './lib/cn';

export { Button, buttonVariants } from './components/button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './components/button';

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './components/card';

export { Skeleton } from './components/skeleton';

export { AppMark } from './components/app-mark';
export type { AppMarkProps } from './components/app-mark';

export { EmptyState } from './components/empty-state';
export type { EmptyStateProps } from './components/empty-state';

export {
  AlertBanner,
  AlertBannerTitle,
  AlertBannerDescription,
} from './components/alert-banner';
export type { AlertBannerProps, AlertBannerVariant } from './components/alert-banner';

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './components/dialog';
export type { DialogContentProps } from './components/dialog';

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './components/alert-dialog';

export { ConfirmationDialog } from './components/confirmation-dialog';
export type { ConfirmationDialogProps } from './components/confirmation-dialog';

export { Label } from './components/label';
export { Input } from './components/input';
export { Textarea } from './components/textarea';
export { Checkbox } from './components/checkbox';

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from './components/select';
