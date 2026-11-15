/**
 * BACKLOG-3962 PR4a R1: /login shows its own message for existing_account and domain_managed,
 * not the org_not_setup block.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

let currentSearchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({ useSearchParams: () => currentSearchParams }));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: jest.fn().mockResolvedValue({ error: null }) } }),
}));

import LoginPage from '@/app/login/page';

it.each([
  ['existing_account', "You already have a Keepr account, so you weren't added to a brokerage automatically. If your brokerage moves your account, you'll get an email first."],
  ['domain_managed', 'Your brokerage manages Keepr accounts for your email domain. Ask your brokerage to invite you, then open the invitation email.'],
])('?error=%s shows its own message', async (code, text) => {
  currentSearchParams = new URLSearchParams({ error: code });
  render(<LoginPage />);
  expect(await screen.findByText(text)).toBeInTheDocument();
});
