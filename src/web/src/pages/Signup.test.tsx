import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Signup, VerifyEmail, slugFrom } from './Signup';
import { mockApi } from '../test/setup';

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/signup" element={<Signup />} /><Route path="/verify-email" element={<VerifyEmail />} /><Route path="/login" element={<p>Login page</p>} /></Routes>
  </MemoryRouter>);

describe('slugFrom', () => {
  it('makes a valid web address from a business name', () => {
    expect(slugFrom("Asha's  Corner Shop!")).toBe('asha-s-corner-shop');
    expect(slugFrom('  --Café  ')).toBe('cafe');
  });
});

describe('Signup', () => {
  it('suggests the address, posts the form and tells the owner to check their email', async () => {
    const calls = mockApi({ 'POST /signup': { message: 'ok' } });
    renderAt('/signup');
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Corner Shop' } });
    expect(screen.getByLabelText('Web address')).toHaveValue('corner-shop');
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Asha' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/signup')?.body).toEqual({ businessName: 'Corner Shop', slug: 'corner-shop', ownerName: 'Asha', email: 'a@b.c', password: 'a-long-password' });
    expect(screen.getByText(/confirmation link to a@b\.c/)).toBeInTheDocument();
  });

  it('shows the server message when the address is taken', async () => {
    mockApi({ 'POST /signup': new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'This web address is already taken' } }), { status: 409 }) });
    renderAt('/signup');
    for (const [label, value] of [['Business name', 'Corner Shop'], ['Your name', 'A'], ['Email', 'a@b.c'], ['Password', 'a-long-password']]) fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/already taken/)).toBeInTheDocument();
  });
});

describe('VerifyEmail', () => {
  it('confirms the link once and offers sign in', async () => {
    const calls = mockApi({ 'POST /signup/verify': { slug: 'corner-shop' } });
    renderAt('/verify-email?token=abc');
    expect(await screen.findByText(/You're all set/)).toBeInTheDocument();
    expect(screen.getByText(/ready at \/shop\/corner-shop/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/signup/verify')).toHaveLength(1);
  });
  it('explains a bad link', async () => {
    mockApi({ 'POST /signup/verify': new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'This link is invalid or has expired. Request a new one.' } }), { status: 400 }) });
    renderAt('/verify-email?token=abc');
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
  });
});
