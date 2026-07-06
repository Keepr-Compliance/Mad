import * as React from 'react';
import { render, screen } from '@testing-library/react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card';

describe('Card', () => {
  it('renders the full card composition', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Billing</CardTitle>
          <CardDescription>Manage your plan</CardDescription>
        </CardHeader>
        <CardContent>Body content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );

    expect(
      screen.getByRole('heading', { name: 'Billing' })
    ).toBeInTheDocument();
    expect(screen.getByText('Manage your plan')).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
    expect(screen.getByText('Footer')).toBeInTheDocument();
  });

  it('carries the Keepr card surface classes and merges className', () => {
    render(
      <Card data-testid="card" className="w-80">
        content
      </Card>
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass('rounded-lg');
    expect(card).toHaveClass('bg-card');
    expect(card).toHaveClass('shadow-sm');
    expect(card).toHaveClass('w-80');
  });
});
