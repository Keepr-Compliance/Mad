/**
 * Design-system primitive contracts (BACKLOG-1811)
 *
 * Rendering tests for the presentational primitives: variant/size class
 * contracts, prop passthrough, and structural conventions from
 * packages/design-system/DESIGN-SYSTEM.md.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  Alert,
  Badge,
  badgeHueClasses,
  Button,
  buttonClasses,
  Card,
  CardHeader,
  CardTitle,
  cardSurfaceClasses,
  Checkbox,
  cn,
  EmptyState,
  FieldError,
  Input,
  inputClasses,
  Label,
  LoadingState,
  PageHeader,
  PaginationButton,
  SearchInput,
  Skeleton,
  Spinner,
  StatCard,
  TableEmptyRow,
  Td,
  Textarea,
  Th,
} from '@keepr/design-system';

describe('cn', () => {
  it('joins truthy classes and skips falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
});

describe('Button', () => {
  it('defaults to type=button with primary md classes', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button.className).toContain('bg-primary-600');
    expect(button.className).toContain('px-4 py-2');
  });

  it('applies variant and size classes', () => {
    render(<Button variant="danger" size="xs">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.className).toContain('bg-red-600');
    expect(button.className).toContain('text-xs');
  });

  it('passes through disabled and onClick', () => {
    const onClick = jest.fn();
    render(<Button disabled onClick={onClick}>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toBeDisabled();
    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('buttonClasses composes variant, size, and custom classes for links', () => {
    const classes = buttonClasses('secondary', 'sm', 'w-full');
    expect(classes).toContain('border-gray-300');
    expect(classes).toContain('px-3 py-1.5');
    expect(classes).toContain('w-full');
  });
});

describe('Badge', () => {
  it('follows the bg-{hue}-100 text-{hue}-800 pill formula', () => {
    render(<Badge hue="green">Active</Badge>);
    const badge = screen.getByText('Active');
    expect(badge.className).toContain('bg-green-100');
    expect(badge.className).toContain('text-green-800');
    expect(badge.className).toContain('rounded-full');
  });

  it('sm size uses the tighter table-embedded padding', () => {
    render(<Badge size="sm">Tiny</Badge>);
    expect(screen.getByText('Tiny').className).toContain('px-2');
  });

  it('badgeHueClasses exposes the raw formula', () => {
    expect(badgeHueClasses('primary')).toBe('bg-primary-100 text-primary-800');
  });
});

describe('Alert', () => {
  it('error variant renders role=alert with red styling', () => {
    render(<Alert variant="error">Something failed</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-red-50');
    expect(alert).toHaveTextContent('Something failed');
  });

  it('non-error variants have no alert role', () => {
    render(<Alert variant="success">Saved</Alert>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});

describe('form controls', () => {
  it('Label renders the required asterisk', () => {
    render(<Label required>Email</Label>);
    expect(screen.getByText('*')).toHaveClass('text-red-500');
  });

  it('Input applies the shared control contract', () => {
    render(<Input placeholder="Name" />);
    const input = screen.getByPlaceholderText('Name');
    for (const cls of ['rounded-md', 'border-gray-300', 'text-sm']) {
      expect(input.className).toContain(cls);
    }
    expect(inputClasses).toContain('focus:ring-primary-500');
  });

  it('Textarea appends resize-none', () => {
    render(<Textarea placeholder="Notes" />);
    expect(screen.getByPlaceholderText('Notes').className).toContain('resize-none');
  });

  it('Checkbox renders a checkbox with primary accent', () => {
    render(<Checkbox aria-label="pick" />);
    const box = screen.getByRole('checkbox', { name: 'pick' });
    expect(box.className).toContain('text-primary-600');
  });

  it('SearchInput renders the magnifier and optional trailing adornment', () => {
    const { container } = render(<SearchInput placeholder="Search" trailing={<span>x</span>} />);
    expect(container.querySelector('svg')).not.toBeNull();
    const input = screen.getByPlaceholderText('Search');
    expect(input.className).toContain('pl-10');
    expect(input.className).toContain('pr-10');
  });

  it('FieldError renders red helper text', () => {
    render(<FieldError>Required</FieldError>);
    expect(screen.getByText('Required').className).toContain('text-red-600');
  });
});

describe('Card family', () => {
  it('Card uses the canonical surface with padding variants', () => {
    const { container } = render(<Card padding="lg">Body</Card>);
    const card = container.firstElementChild as HTMLElement;
    for (const cls of cardSurfaceClasses.split(' ')) {
      expect(card.className).toContain(cls);
    }
    expect(card.className).toContain('p-8');
  });

  it('CardHeader renders the action slot right-aligned', () => {
    render(
      <CardHeader action={<button>New</button>}>
        <CardTitle>People</CardTitle>
      </CardHeader>
    );
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByText('People').className).toContain('text-lg font-semibold');
  });
});

describe('Table primitives', () => {
  it('Th and Td follow the admin table recipe', () => {
    render(
      <table>
        <thead><tr><Th>Name</Th></tr></thead>
        <tbody><tr><Td emphasis="primary">Ada</Td><Td>meta</Td></tr></tbody>
      </table>
    );
    expect(screen.getByText('Name').className).toContain('uppercase tracking-wider');
    expect(screen.getByText('Ada').className).toContain('font-medium text-gray-900');
    expect(screen.getByText('meta').className).toContain('text-gray-500');
  });

  it('TableEmptyRow spans the given columns', () => {
    render(
      <table><tbody><TableEmptyRow colSpan={5}>No results</TableEmptyRow></tbody></table>
    );
    const cell = screen.getByText('No results').closest('td');
    expect(cell).toHaveAttribute('colspan', '5');
  });

  it('PaginationButton renders direction labels and disabled state', () => {
    render(<PaginationButton direction="prev" disabled />);
    const button = screen.getByRole('button', { name: /Previous/ });
    expect(button).toBeDisabled();
  });
});

describe('page scaffolding', () => {
  it('PageHeader renders h1 + subtitle + actions', () => {
    render(<PageHeader title="Users" subtitle="12 total" actions={<button>Invite</button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Users' }).className).toContain('text-2xl font-bold');
    expect(screen.getByText('12 total').className).toContain('text-gray-500');
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
  });

  it('StatCard renders label, value, and trend color', () => {
    render(<StatCard label="Open" value={7} trend="+2" trendDirection="up" />);
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('7').className).toContain('text-2xl font-semibold');
    expect(screen.getByText('+2').className).toContain('text-green-600');
  });

  it('EmptyState renders with and without card chrome', () => {
    const { container, rerender } = render(<EmptyState title="Nothing here" card />);
    expect((container.firstElementChild as HTMLElement).className).toContain('border-gray-200');
    rerender(<EmptyState title="Nothing here" card={false} />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain('border-gray-200');
  });
});

describe('loading states', () => {
  it('Skeleton pulses', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect((container.firstElementChild as HTMLElement).className).toContain('animate-pulse');
  });

  it('Spinner sizes and LoadingState centering', () => {
    const { container } = render(<Spinner size="sm" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('h-4 w-4');
    const { container: loading } = render(<LoadingState />);
    expect((loading.firstElementChild as HTMLElement).className).toContain('justify-center');
  });
});
