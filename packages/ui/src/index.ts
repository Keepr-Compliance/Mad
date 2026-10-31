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

export { Wordmark, KEEPR_DOT_COLOR } from './components/wordmark';
export type { WordmarkProps } from './components/wordmark';

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

// Dropdown (BACKLOG-4032) — searchable single- or multi-choice picker; see README "Dropdown".
export { Dropdown, DropdownOptions, filterDropdownOptions, dropdownSide } from './components/dropdown';
export type {
  DropdownOption,
  DropdownProps,
  DropdownSingleProps,
  DropdownMultiProps,
  DropdownLabelling,
  DropdownOptionsProps,
} from './components/dropdown';

// DateRangePicker (BACKLOG-4032 slice 3) — two-month calendar pill, commits on Apply; see README "DateRangePicker".
export { DateRangePicker } from './components/date-range';
export type { DateRangePickerProps, DateRangeValue } from './components/date-range';

// Phone kit (BACKLOG-3895) — phone-width components; see DESIGN-SYSTEM.md "Phone".
export * from './components/phone';

// Report kit (BACKLOG-3502a) — desktop report tables, filters, cards, URL state; see README "Report kit".
export * from './components/report';
export * from './components/saved-views';
// BACKLOG-4007 PR-4: a brokerage's people (billing / IT / office / MSP), shared by both portals.
export { OrgPeoplePanel, orgPeopleErrorMessage } from './components/org-people';
export type {
  OrgContactRole,
  OrgPeopleContact,
  OrgPeopleMember,
  OrgPeopleView,
  OrgPeopleInviteSlot,
  OrgPeopleSaveInput,
  OrgPeopleResult,
  OrgPeopleActions,
  OrgPeoplePhoneRule,
  OrgPeoplePanelProps,
  OrgPeopleInviteInput,
  OrgPeopleInviteResult,
  OrgPeopleUserRef,
} from './components/org-people';
